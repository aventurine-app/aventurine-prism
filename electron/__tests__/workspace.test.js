'use strict';

// The plans file: persistence, atomic saves, validation at the gate,
// encryption at rest and the locked-file rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Plan = require('../../static/js/sim/plan.js');
const vault = require('../backend/vault');
const { createWorkspace, WorkspaceError } = require('../backend/workspace');
const { dispatch } = require('../backend/routes');

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citrine-test-'));
    tmpDirs.push(dir);
    return path.join(dir, 'plans.prism');
}

function open(file) {
    const ws = createWorkspace({ filePath: file });
    ws.init();
    return ws;
}

function samplePlan(name = 'Sample') {
    const plan = Plan.createPlan({ name, start: '2026-01', years: 2 });
    const salary = Plan.createNode(plan, 'salary', 0, 0);
    const savings = Plan.createNode(plan, 'bank-account', 300, 0);
    plan.nodes.push(salary, savings);
    plan.links.push(Plan.createLink(plan, salary.id, savings.id));
    return plan;
}

const ctxFor = (ws, dialogs = {}) => ({ workspace: ws, dialogs });

test('a fresh install starts empty and creates the file on first save', () => {
    const file = tmpFile();
    const ws = open(file);
    assert.deepEqual(ws.listPlans(), { plans: [], order: [], active: null });
    assert.equal(fs.existsSync(file), false);
    ws.addPlan(samplePlan());
    assert.equal(fs.existsSync(file), true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('plans, tab order and the active tab survive a restart', () => {
    const file = tmpFile();
    const ws = open(file);
    const a = ws.addPlan(samplePlan('A'));
    const b = ws.addPlan(samplePlan('B'));
    ws.setTabs({ order: [b.id, a.id], active: a.id });
    const again = open(file);
    const list = again.listPlans();
    assert.deepEqual(list.order, [b.id, a.id]);
    assert.equal(list.active, a.id);
    assert.equal(again.getPlan(a.id).nodes.length, 2);
});

test('an invalid save is rejected and the file is left untouched', () => {
    const file = tmpFile();
    const ws = open(file);
    const plan = ws.addPlan(samplePlan());
    const before = fs.readFileSync(file, 'utf8');
    const bad = JSON.parse(JSON.stringify(plan));
    bad.links[0].to = 'n_missing';
    assert.throws(() => ws.putPlan(plan.id, bad), (e) => e.status === 422);
    bad.links[0].to = plan.nodes[1].id;
    bad.nodes[0].type = 'not-a-module';
    assert.throws(() => ws.putPlan(plan.id, bad), (e) => e.status === 422);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('saves are atomic and the first save of a session keeps a .bak', () => {
    const file = tmpFile();
    const ws = open(file);
    const plan = ws.addPlan(samplePlan('First'));
    const ws2 = open(file);
    const renamed = { ...ws2.getPlan(plan.id), name: 'Second' };
    ws2.putPlan(plan.id, renamed);
    const bak = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
    assert.equal(bak.plans[0].name, 'First');
    assert.equal(open(file).getPlan(plan.id).name, 'Second');
    const strays = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(strays, []);
});

test('tab order must name every plan exactly once', () => {
    const ws = open(tmpFile());
    const a = ws.addPlan(samplePlan('A'));
    ws.addPlan(samplePlan('B'));
    assert.throws(() => ws.setTabs({ order: [a.id] }), (e) => e.status === 400);
    assert.throws(() => ws.setTabs({ order: [a.id, a.id] }), (e) => e.status === 400);
});

test('deleting the active plan activates its neighbour', () => {
    const ws = open(tmpFile());
    const a = ws.addPlan(samplePlan('A'));
    const b = ws.addPlan(samplePlan('B'));
    const c = ws.addPlan(samplePlan('C'));
    ws.setTabs({ order: [a.id, b.id, c.id], active: b.id });
    assert.deepEqual(ws.deletePlan(b.id), { order: [a.id, c.id], active: c.id });
});

test('a file that is not a plans file is refused, not overwritten', () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'this is not json');
    assert.throws(() => open(file), (e) => e instanceof WorkspaceError && e.code === 'unreadable');
    assert.equal(fs.readFileSync(file, 'utf8'), 'this is not json');
});

test('a plan this build cannot read is quarantined and written back intact', () => {
    const file = tmpFile();
    const good = samplePlan('Good');
    const odd = { ...samplePlan('From the future'), nodes: [{ id: 'n_x', type: 'time-machine', x: 0, y: 0, params: {} }], links: [] };
    fs.writeFileSync(file, JSON.stringify({
        format: 'citrine-workspace', version: 1, plans: [good, odd], order: [good.id, odd.id], active: good.id,
    }));
    const ws = open(file);
    assert.equal(ws.listPlans().plans.length, 1);
    assert.equal(ws.status().quarantined, 1);
    ws.putPlan(good.id, ws.getPlan(good.id));
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk.quarantine[0].nodes[0].type, 'time-machine');
});

test('encryption: sealed on disk, locked on open, unlocked by the password only', async () => {
    const file = tmpFile();
    const ws = open(file);
    ws.addPlan(samplePlan('Secret plan name'));
    await assert.rejects(ws.setEncryption({ action: 'encrypt', password: 'short' }), (e) => e.status === 400);
    await ws.setEncryption({ action: 'encrypt', password: 'correct horse' });

    const disk = fs.readFileSync(file, 'utf8');
    assert.ok(!disk.includes('Secret plan name'));
    assert.equal(JSON.parse(disk).format, 'citrine-encrypted');
    // The .bak is replaced too, so no plaintext copy sits beside the file.
    assert.ok(!fs.readFileSync(`${file}.bak`, 'utf8').includes('Secret plan name'));

    const again = open(file);
    assert.equal(again.isLocked(), true);
    const ctx = ctxFor(again);
    assert.equal((await dispatch(ctx, 'GET', '/api/plans', null)).status, 423);
    assert.equal((await dispatch(ctx, 'GET', '/api/file/status', null)).status, 200);
    const wrong = await dispatch(ctx, 'POST', '/api/file/unlock', { password: 'wrong horse' });
    assert.equal(wrong.status, 401);
    const right = await dispatch(ctx, 'POST', '/api/file/unlock', { password: 'correct horse' });
    assert.equal(right.status, 200);
    assert.equal(right.body.locked, false);
    assert.equal((await dispatch(ctx, 'GET', '/api/plans', null)).body.plans[0].name, 'Secret plan name');
});

test('encryption: change the password, then remove it', async () => {
    const file = tmpFile();
    const ws = open(file);
    ws.addPlan(samplePlan('P'));
    await ws.setEncryption({ action: 'encrypt', password: 'first password' });
    await assert.rejects(ws.setEncryption({ action: 'change', current: 'nope', password: 'second password' }),
        (e) => e.status === 401);
    await ws.setEncryption({ action: 'change', current: 'first password', password: 'second password' });

    const again = open(file);
    await assert.rejects(again.unlock('first password'), (e) => e.status === 401);
    await again.unlock('second password');
    await again.setEncryption({ action: 'decrypt', current: 'second password' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).format, 'citrine-workspace');
    assert.equal(open(file).isLocked(), false);
});

test('encryption: a tampered header is refused before any key is derived', async () => {
    const file = tmpFile();
    const ws = open(file);
    ws.addPlan(samplePlan('P'));
    await ws.setEncryption({ action: 'encrypt', password: 'a fine password' });
    const env = JSON.parse(fs.readFileSync(file, 'utf8'));

    fs.writeFileSync(file, JSON.stringify({ ...env, kdf: { ...env.kdf, N: 2 ** 30 } }));
    assert.throws(() => open(file), (e) => e.code === 'unreadable');

    // A header edit inside the bounds fails authentication instead.
    fs.writeFileSync(file, JSON.stringify({ ...env, kdf: { ...env.kdf, N: 2 ** 15 } }));
    await assert.rejects(open(file).unlock('a fine password'), (e) => e.status === 401);
});

/** Run `fn` with every rename failing, as a full disk would make the final
 *  step of an atomic write fail. */
async function withFailingRename(fn) {
    const rename = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    try {
        return await fn();
    } finally {
        fs.renameSync = rename;
    }
}

test('encryption: turning it on when the write fails leaves the file and the status in the clear', async () => {
    const file = tmpFile();
    const ws = open(file);
    const p = ws.addPlan(samplePlan('Plain'));
    await withFailingRename(() => assert.rejects(
        ws.setEncryption({ action: 'encrypt', password: 'correct horse' }), /disk full/));
    assert.equal(ws.status().encrypted, false);
    ws.putPlan(p.id, ws.getPlan(p.id));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).format, 'citrine-workspace');
    await ws.setEncryption({ action: 'encrypt', password: 'correct horse' });
    assert.equal(open(file).isLocked(), true);
});

test('encryption: a password change whose write fails keeps the old password', async () => {
    const file = tmpFile();
    const ws = open(file);
    const p = ws.addPlan(samplePlan('P'));
    await ws.setEncryption({ action: 'encrypt', password: 'first password' });
    await withFailingRename(() => assert.rejects(
        ws.setEncryption({ action: 'change', current: 'first password', password: 'second password' }), /disk full/));
    // A later save still seals the file under the password the user kept.
    ws.putPlan(p.id, ws.getPlan(p.id));
    const again = open(file);
    await assert.rejects(again.unlock('second password'), (e) => e.status === 401);
    await again.unlock('first password');
});

test('encryption: a file this build cannot read answers 422 once unlocked, not an internal error', async () => {
    const file = tmpFile();
    const kdf = vault.newKdf();
    const key = await vault.deriveKey('a fine password', kdf);
    fs.writeFileSync(file, vault.seal(JSON.stringify({ format: 'citrine-workspace', version: 99, plans: [] }), key, kdf));
    const ctx = ctxFor(open(file));
    const r = await dispatch(ctx, 'POST', '/api/file/unlock', { password: 'a fine password' });
    assert.deepEqual([r.status, r.body.error], [422, 'too_new']);
    assert.equal((await dispatch(ctx, 'GET', '/api/plans', null)).status, 423);
});

test('vault: a truncated tag does not open the file, even with the right key', async () => {
    const kdf = vault.newKdf();
    const key = await vault.deriveKey('a fine password', kdf);
    const env = JSON.parse(vault.seal('secret', key, kdf));
    assert.equal(vault.open(env, key), 'secret');
    const short = { ...env, tag: Buffer.from(env.tag, 'base64').subarray(0, 12).toString('base64') };
    assert.throws(() => vault.open(short, key), (e) => e instanceof vault.VaultError);
});

test('locking drops the plans until the password is given again', async () => {
    const file = tmpFile();
    const ws = open(file);
    const p = ws.addPlan(samplePlan('P'));
    await ws.setEncryption({ action: 'encrypt', password: 'a fine password' });
    ws.lock();
    assert.equal(ws.isLocked(), true);
    await ws.unlock('a fine password');
    assert.equal(ws.getPlan(p.id).name, 'P');
});

test('router: export and import go through the injected dialogs', async () => {
    const file = tmpFile();
    const ws = open(file);
    const plan = ws.addPlan(samplePlan('Shared'));
    const out = path.join(path.dirname(file), 'shared.json');
    const ctx = ctxFor(ws, {
        chooseExportPath: async () => out,
        chooseImportPath: async () => out,
    });
    const exp = await dispatch(ctx, 'POST', `/api/plans/${plan.id}/export`, null);
    assert.equal(exp.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).plan.name, 'Shared');

    const imp = await dispatch(ctx, 'POST', '/api/plans/import', null);
    assert.equal(imp.status, 200);
    assert.notEqual(imp.body.plan.id, plan.id);
    assert.equal(imp.body.plan.name, 'Shared');
    assert.notEqual(imp.body.plan.nodes[0].id, plan.nodes[0].id);
    assert.equal(ws.listPlans().plans.length, 2);

    const cancel = await dispatch(ctxFor(ws, { chooseImportPath: async () => null }), 'POST', '/api/plans/import', null);
    assert.deepEqual(cancel.body, { canceled: true });
});

test('router: import refuses a folder or a missing file with 422', async () => {
    const file = tmpFile();
    const ws = open(file);
    const importFrom = (target) => dispatch(ctxFor(ws, { chooseImportPath: async () => target }), 'POST', '/api/plans/import', null);
    assert.equal((await importFrom(path.dirname(file))).status, 422);
    assert.equal((await importFrom(path.join(path.dirname(file), 'gone.json'))).status, 422);
    assert.equal(ws.listPlans().plans.length, 0);
});

test('router: unknown routes 404, bad bodies 400, missing plans 404', async () => {
    const ctx = ctxFor(open(tmpFile()));
    assert.equal((await dispatch(ctx, 'GET', '/api/nope', null)).status, 404);
    assert.equal((await dispatch(ctx, 'POST', '/api/plans', {})).status, 400);
    assert.equal((await dispatch(ctx, 'GET', '/api/plans/p_missing', null)).status, 404);
    assert.equal((await dispatch(ctx, 'GET', '/api/plans/%E0%A4%A', null)).status, 400);
});

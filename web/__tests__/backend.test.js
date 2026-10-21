'use strict';

// The browser backend's URL map: the same routes, bodies and status codes the
// app's call sites were written against, plus export and import through the
// file dialogs (faked here).

const test = require('node:test');
const assert = require('node:assert/strict');

const Plan = require('../../static/js/sim/plan.js');
const { createWorkspace } = require('../../static/js/web/workspace.js');
const { createBackend } = require('../../static/js/web/backend.js');
const { PlanFiles } = require('../../static/js/web/plan-files.js');
const { createMemoryStorage } = require('./memory-storage');

const silent = { warn() {}, error() {} };

function samplePlan(name = 'Sample') {
    const plan = Plan.createPlan({ name, start: '2026-01', years: 2 });
    const salary = Plan.createNode(plan, 'salary', 0, 0);
    const savings = Plan.createNode(plan, 'bank-account', 300, 0);
    plan.nodes.push(salary, savings);
    plan.links.push(Plan.createLink(plan, salary.id, savings.id));
    return plan;
}

/** A backend over an empty store. `files` records what it was asked to save. */
async function setup({ openResult = null } = {}) {
    const storage = createMemoryStorage();
    const workspace = createWorkspace({ storage, logger: silent });
    await workspace.init();
    const files = {
        saved: [],
        nextSave: true,
        async save(file) { files.saved.push(file); return files.nextSave; },
        async open() { return openResult; },
    };
    const backend = createBackend({ workspace, files, logger: silent });
    const call = (method, url, body) => backend.dispatch(method, url, body);
    return { call, files, storage, workspace };
}

test('a plan is created, listed, read, saved and deleted over the same URLs as before', async () => {
    const { call } = await setup();
    const plan = samplePlan();

    const created = await call('POST', '/api/plans', { plan });
    assert.equal(created.status, 200);
    const id = created.body.plan.id;

    assert.deepEqual((await call('GET', '/api/plans')).body.order, [id]);
    assert.equal((await call('GET', `/api/plans/${id}`)).body.plan.name, 'Sample');

    const edited = { ...created.body.plan, name: 'Edited' };
    const put = await call('PUT', `/api/plans/${id}`, { plan: edited });
    assert.equal(put.status, 200);
    assert.ok(put.body.updatedAt);
    assert.equal((await call('GET', `/api/plans/${id}`)).body.plan.name, 'Edited');

    const order = await call('PUT', '/api/plans/order', { order: [id], active: id });
    assert.deepEqual(order.body, { order: [id], active: id });

    const removed = await call('DELETE', `/api/plans/${id}`);
    assert.deepEqual(removed.body, { order: [], active: null });
    assert.equal((await call('GET', `/api/plans/${id}`)).status, 404);
});

test('status says the plans are in the browser, unencrypted and open', async () => {
    const { call } = await setup();
    const r = await call('GET', '/api/file/status');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { storage: 'browser', encrypted: false, locked: false, plans: 0, quarantined: 0 });
});

test('errors keep the { ok: false, error } shape and the statuses the app checks', async () => {
    const { call } = await setup();
    assert.deepEqual((await call('GET', '/api/nothing')).body, { ok: false, error: 'not found' });
    assert.equal((await call('GET', '/api/nothing')).status, 404);

    assert.deepEqual(await call('POST', '/api/plans', {}), { status: 400, body: { ok: false, error: 'plan required' } });
    assert.equal((await call('POST', '/api/plans', { plan: { junk: 1 } })).status, 422);
    assert.equal((await call('GET', '/api/plans/missing')).status, 404);
    assert.equal((await call('DELETE', '/api/plans/missing')).status, 404);
    assert.equal((await call('GET', '/api/plans/%E0%A4%A')).status, 400, 'a malformed escape is a bad request');
});

test('encryption and locking are not offered in the browser', async () => {
    const { call } = await setup();
    assert.equal((await call('POST', '/api/file/unlock', { password: 'x' })).status, 404);
    assert.equal((await call('POST', '/api/file/lock')).status, 404);
    assert.equal((await call('POST', '/api/file/encryption', { action: 'encrypt' })).status, 404);
});

test('what the page sends and receives is a copy, never the stored object', async () => {
    const { call } = await setup();
    const plan = samplePlan('Original');
    const created = await call('POST', '/api/plans', { plan });
    const id = created.body.plan.id;

    plan.name = 'Changed by the page after sending';
    created.body.plan.name = 'Changed by the page after receiving';
    assert.equal((await call('GET', `/api/plans/${id}`)).body.plan.name, 'Original');
});

test('an unexpected failure is a plain 500 that leaks nothing', async () => {
    const backend = createBackend({
        workspace: { listPlans() { throw new Error('secret detail'); } },
        files: {},
        logger: silent,
    });
    assert.deepEqual(await backend.dispatch('GET', '/api/plans'), { status: 500, body: { ok: false, error: 'internal error' } });
});

// ── Export and import ──────────────────────────────────────────────────────

test('exporting hands the file dialog a named, readable plan file', async () => {
    const { call, files } = await setup();
    const { body: { plan } } = await call('POST', '/api/plans', { plan: samplePlan('Retire: 2040?') });

    const r = await call('POST', `/api/plans/${plan.id}/export`);
    assert.deepEqual(r.body, { saved: true });
    assert.equal(files.saved.length, 1);
    assert.equal(files.saved[0].name, 'Retire 2040.json', 'characters file systems refuse are dropped');

    const file = JSON.parse(files.saved[0].text);
    assert.equal(file.format, 'citrine-plan');
    assert.equal(file.plan.id, plan.id);
});

test('cancelling the save dialog is not an error', async () => {
    const { call, files } = await setup();
    const { body: { plan } } = await call('POST', '/api/plans', { plan: samplePlan() });
    files.nextSave = false;
    assert.deepEqual((await call('POST', `/api/plans/${plan.id}/export`)).body, { canceled: true });
});

test('exporting a plan that does not exist is a 404 and opens no dialog', async () => {
    const { call, files } = await setup();
    assert.equal((await call('POST', '/api/plans/missing/export')).status, 404);
    assert.equal(files.saved.length, 0);
});

test('an exported plan imports as a new plan with new ids', async () => {
    const source = await setup();
    const { body: { plan } } = await source.call('POST', '/api/plans', { plan: samplePlan('Travel') });
    await source.call('POST', `/api/plans/${plan.id}/export`);
    const text = source.files.saved[0].text;

    const target = await setup({ openResult: text });
    const r = await target.call('POST', '/api/plans/import');
    assert.equal(r.status, 200);
    assert.equal(r.body.plan.name, 'Travel');
    assert.notEqual(r.body.plan.id, plan.id);
    assert.deepEqual((await target.call('GET', '/api/plans')).body.order, [r.body.plan.id]);
});

test('a bare plan object imports too, as older plan files were', async () => {
    const { call } = await setup({ openResult: JSON.stringify(samplePlan('Bare')) });
    const r = await call('POST', '/api/plans/import');
    assert.equal(r.body.plan.name, 'Bare');
});

test('cancelling the file picker imports nothing', async () => {
    const { call } = await setup({ openResult: null });
    assert.deepEqual((await call('POST', '/api/plans/import')).body, { canceled: true });
    assert.deepEqual((await call('GET', '/api/plans')).body.order, []);
});

test('importing something that is not a plan is refused with a reason', async () => {
    const notJson = await setup({ openResult: 'hello' });
    assert.deepEqual(await notJson.call('POST', '/api/plans/import'),
        { status: 422, body: { ok: false, error: 'not an Aventurine Prism plan file' } });

    const notAPlan = await setup({ openResult: JSON.stringify({ format: 'citrine-plan', plan: { junk: true } }) });
    assert.equal((await notAPlan.call('POST', '/api/plans/import')).status, 422);

    const tooBig = await setup({ openResult: ' '.repeat(PlanFiles.MAX_IMPORT_BYTES + 1) });
    assert.equal((await tooBig.call('POST', '/api/plans/import')).status, 422);
});

test('the file picker is opened before anything is awaited', async () => {
    const { workspace } = await setup();
    let opened = false;
    const backend = createBackend({ workspace, files: { async open() { opened = true; return null; } }, logger: silent });
    const pending = backend.dispatch('POST', '/api/plans/import');
    assert.equal(opened, true, 'the picker needs the click that asked for it');
    await pending;
});

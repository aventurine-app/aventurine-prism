'use strict';

// ─── workspace.js ───────────────────────────────────────────────────────────
// The plans file: one local file holding every plan the user has, which is
// all the persistent state Aventurine Prism has. Plans are tabs in the app; this module
// keeps them in memory, validates every change, and writes the whole file back
// on each save.
//
// The file is JSON, either plain:
//
//   { format: 'citrine-workspace', version, plans: [...], order: [...],
//     active, quarantine: [...] }
//
// or that same document sealed inside an encrypted envelope (vault.js).
//
// Writes are atomic: a temp file in the same folder, fsync'd, then renamed over
// the real one, so a crash mid-write leaves the previous file intact. The first
// save of each session copies the file to `<file>.bak` before touching it.
// Neither sidecar is ever swept: a .bak that is newer than you expected may be
// the only intact copy.
//
// A plan that fails validation on load (say, a module type from a newer build)
// is not dropped: it moves to `quarantine` verbatim and is written back on
// every save, so opening the file in an older build loses nothing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Plan = require('../../static/js/sim/plan.js');
const vault = require('./vault');
const { ApiError } = require('./router');

const FORMAT = 'citrine-workspace';
const PLAN_FILE_FORMAT = 'citrine-plan';
const VERSION = 1;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_PLANS = 100;
const MIN_PASSWORD = 8;

class WorkspaceError extends Error {
    constructor(code, detail) {
        super(detail ? `${code}: ${detail}` : code);
        this.code = code;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emptyDoc() {
    return { format: FORMAT, version: VERSION, plans: [], order: [], active: null, quarantine: [] };
}

function planMeta(p) {
    return { id: p.id, name: p.name, updatedAt: p.updatedAt, modules: p.nodes.length };
}

/** Write `text` to `file` atomically, owner-only. */
function writeAtomic(file, text) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        throw e;
    }
    // Make the rename itself durable. Not supported on Windows; harmless there.
    try {
        const dfd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* best effort */ }
}

function createWorkspace({ filePath }) {
    const state = {
        path: filePath,
        encrypted: false,
        locked: false,
        envelope: null,     // the sealed file while locked
        key: null,          // derived key while unlocked
        kdf: null,
        doc: null,
        backedUp: false,
        failures: 0,        // consecutive wrong passwords
    };

    // ── Loading ────────────────────────────────────────────────────────────

    function readFile() {
        let st;
        try {
            st = fs.statSync(filePath);
        } catch (e) {
            if (e.code === 'ENOENT') return null;
            throw e;
        }
        if (st.size > MAX_FILE_BYTES) throw new WorkspaceError('unreadable', 'file is too large');
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            throw new WorkspaceError('unreadable', 'not an Aventurine Prism plans file');
        }
    }

    function loadDoc(parsed) {
        if (!parsed || parsed.format !== FORMAT) throw new WorkspaceError('unreadable', 'not an Aventurine Prism plans file');
        if (!(parsed.version <= VERSION)) throw new WorkspaceError('too_new');
        const doc = emptyDoc();
        for (const raw of Array.isArray(parsed.plans) ? parsed.plans : []) {
            try {
                doc.plans.push(Plan.validatePlan(raw));
            } catch (e) {
                console.warn('[workspace] plan moved to quarantine:', e.message);
                doc.quarantine.push(raw);
            }
        }
        if (Array.isArray(parsed.quarantine)) doc.quarantine.push(...parsed.quarantine);
        const ids = new Set(doc.plans.map((p) => p.id));
        const order = (Array.isArray(parsed.order) ? parsed.order : []).filter((id) => ids.delete(id));
        doc.order = [...order, ...ids];
        doc.active = doc.order.includes(parsed.active) ? parsed.active : (doc.order[0] || null);
        return doc;
    }

    function init() {
        const parsed = readFile();
        if (parsed == null) {
            state.doc = emptyDoc();
            return;
        }
        if (vault.isEnvelope(parsed)) {
            try {
                vault.checkEnvelope(parsed);
            } catch (e) {
                throw new WorkspaceError(e.code === 'too_new' ? 'too_new' : 'unreadable', 'encryption header');
            }
            state.encrypted = true;
            state.locked = true;
            state.envelope = parsed;
            return;
        }
        state.doc = loadDoc(parsed);
    }

    // ── Saving ─────────────────────────────────────────────────────────────

    function serialize() {
        const doc = state.doc;
        const plans = doc.order.map((id) => doc.plans.find((p) => p.id === id));
        const body = { format: FORMAT, version: VERSION, plans, order: doc.order, active: doc.active };
        if (doc.quarantine.length) body.quarantine = doc.quarantine;
        if (!state.encrypted) return JSON.stringify(body, null, 2);
        return vault.seal(JSON.stringify(body), state.key, state.kdf);
    }

    /** Write the whole file. `refreshBackup` replaces the .bak with the new
     *  file: used when encryption changes, so no copy under the old (or no)
     *  password is left lying beside it. */
    function save({ refreshBackup = false } = {}) {
        if (!state.backedUp && !refreshBackup && fs.existsSync(filePath)) {
            fs.copyFileSync(filePath, `${filePath}.bak`);
            try { fs.chmodSync(`${filePath}.bak`, 0o600); } catch { /* not supported */ }
        }
        state.backedUp = true;
        writeAtomic(filePath, serialize());
        if (refreshBackup) {
            fs.copyFileSync(filePath, `${filePath}.bak`);
            try { fs.chmodSync(`${filePath}.bak`, 0o600); } catch { /* not supported */ }
        }
    }

    // ── Locking and encryption ─────────────────────────────────────────────

    function zeroKey() {
        if (state.key) state.key.fill(0);
        state.key = null;
    }

    async function penalty() {
        state.failures += 1;
        await sleep(Math.min(3000, 250 * 2 ** (state.failures - 1)));
    }

    async function unlock(password) {
        if (!state.locked) return status();
        if (typeof password !== 'string' || !password) throw new ApiError('password required', 400);
        const env = state.envelope;
        const key = await vault.deriveKey(password, env.kdf);
        let text;
        try {
            text = vault.open(env, key);
        } catch {
            key.fill(0);
            await penalty();
            throw new ApiError('wrong_password', 401);
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new ApiError('unreadable', 422);
        }
        state.doc = loadDoc(parsed);
        state.key = key;
        state.kdf = env.kdf;
        state.envelope = null;
        state.locked = false;
        state.failures = 0;
        return status();
    }

    function lock() {
        if (!state.encrypted || state.locked) return status();
        // Seal the in-memory document rather than re-reading the file, so the
        // envelope held while locked is exactly what was last saved.
        state.envelope = JSON.parse(serialize());
        zeroKey();
        state.doc = null;
        state.locked = true;
        return status();
    }

    async function verifyCurrent(password) {
        if (typeof password !== 'string' || !password) throw new ApiError('password required', 400);
        const key = await vault.deriveKey(password, state.kdf);
        const same = key.length === state.key.length && crypto.timingSafeEqual(key, state.key);
        key.fill(0);
        if (!same) {
            await penalty();
            throw new ApiError('wrong_password', 401);
        }
        state.failures = 0;
    }

    function checkNewPassword(password) {
        if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) {
            throw new ApiError('password_too_short', 400, { min: MIN_PASSWORD });
        }
        if (password.length > 1024) throw new ApiError('password_too_long', 400);
    }

    async function setEncryption({ action, current, password } = {}) {
        if (action === 'encrypt') {
            if (state.encrypted) throw new ApiError('already encrypted', 409);
            checkNewPassword(password);
            const kdf = vault.newKdf();
            state.key = await vault.deriveKey(password, kdf);
            state.kdf = kdf;
            state.encrypted = true;
        } else if (action === 'change') {
            if (!state.encrypted) throw new ApiError('not encrypted', 409);
            await verifyCurrent(current);
            checkNewPassword(password);
            const kdf = vault.newKdf();
            const key = await vault.deriveKey(password, kdf);
            zeroKey();
            state.key = key;
            state.kdf = kdf;
        } else if (action === 'decrypt') {
            if (!state.encrypted) throw new ApiError('not encrypted', 409);
            await verifyCurrent(current);
            zeroKey();
            state.kdf = null;
            state.encrypted = false;
        } else {
            throw new ApiError('unknown action', 400);
        }
        save({ refreshBackup: true });
        return status();
    }

    // ── Plans ──────────────────────────────────────────────────────────────

    function find(id) {
        const p = state.doc.plans.find((x) => x.id === id);
        if (!p) throw new ApiError('plan not found', 404);
        return p;
    }

    function validated(raw) {
        try {
            return Plan.validatePlan(raw);
        } catch (e) {
            if (e instanceof Plan.PlanError) throw new ApiError(e.message, 422);
            throw e;
        }
    }

    function listPlans() {
        const d = state.doc;
        return { plans: d.order.map((id) => planMeta(find(id))), order: d.order, active: d.active };
    }

    function getPlan(id) {
        return find(id);
    }

    function addPlan(raw) {
        const plan = validated(raw);
        if (state.doc.plans.length >= MAX_PLANS) throw new ApiError(`at most ${MAX_PLANS} plans`, 409);
        if (state.doc.plans.some((p) => p.id === plan.id)) throw new ApiError('plan already exists', 409);
        plan.updatedAt = new Date().toISOString();
        state.doc.plans.push(plan);
        state.doc.order.push(plan.id);
        state.doc.active = plan.id;
        save();
        return plan;
    }

    function putPlan(id, raw) {
        const plan = validated(raw);
        if (plan.id !== id) throw new ApiError('plan id mismatch', 400);
        const i = state.doc.plans.findIndex((p) => p.id === id);
        if (i < 0) throw new ApiError('plan not found', 404);
        plan.createdAt = state.doc.plans[i].createdAt;
        plan.updatedAt = new Date().toISOString();
        state.doc.plans[i] = plan;
        save();
        return { updatedAt: plan.updatedAt };
    }

    function deletePlan(id) {
        find(id);
        const d = state.doc;
        d.plans = d.plans.filter((p) => p.id !== id);
        const at = d.order.indexOf(id);
        d.order = d.order.filter((x) => x !== id);
        if (d.active === id) d.active = d.order[Math.min(at, d.order.length - 1)] || null;
        save();
        return { order: d.order, active: d.active };
    }

    function setTabs({ order, active } = {}) {
        const d = state.doc;
        if (!Array.isArray(order) || order.length !== d.order.length
            || new Set(order).size !== order.length || !order.every((id) => d.order.includes(id))) {
            throw new ApiError('order must list every plan once', 400);
        }
        if (active != null && !order.includes(active)) throw new ApiError('unknown active plan', 400);
        d.order = order.slice();
        d.active = active ?? d.active;
        save();
        return { order: d.order, active: d.active };
    }

    /** A plan file as exported: plain JSON, readable without Aventurine Prism. */
    function exportPlan(id, file) {
        const plan = find(id);
        writeAtomic(file, JSON.stringify({
            format: PLAN_FILE_FORMAT, version: VERSION, exportedAt: new Date().toISOString(), plan,
        }, null, 2));
        return { path: file };
    }

    /** Add a plan from an exported file. Ids are regenerated, so importing the
     *  same file twice gives two independent plans. */
    function importPlanFile(file) {
        const st = fs.statSync(file);
        if (st.size > MAX_IMPORT_BYTES) throw new ApiError('file is too large to be a plan', 422);
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            throw new ApiError('not an Aventurine Prism plan file', 422);
        }
        const raw = parsed && parsed.format === PLAN_FILE_FORMAT ? parsed.plan : parsed;
        const fresh = Plan.cloneWithNewIds(validated(raw));
        return addPlan(fresh);
    }

    // ── Status ─────────────────────────────────────────────────────────────

    function status() {
        return {
            path: state.path,
            encrypted: state.encrypted,
            locked: state.locked,
            plans: state.doc ? state.doc.plans.length : null,
            quarantined: state.doc ? state.doc.quarantine.length : 0,
        };
    }

    function close() {
        zeroKey();
    }

    return {
        init, status, isLocked: () => state.locked,
        unlock, lock, setEncryption,
        listPlans, getPlan, addPlan, putPlan, deletePlan, setTabs,
        exportPlan, importPlanFile, close,
    };
}

module.exports = { createWorkspace, WorkspaceError, FORMAT, PLAN_FILE_FORMAT, MIN_PASSWORD };

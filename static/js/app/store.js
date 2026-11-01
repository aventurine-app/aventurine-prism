'use strict';

// ─── store.js ───────────────────────────────────────────────────────────────
// App state and the only ways to change it.
//
//   Store.state         plans (in navigation order: `tabs`), the active plan,
//                       the shared goals, the workspace, selection, results,
//                       the scrubbed month, save state. Read freely; never write.
//   Store.on(fn)        change events: fn({ type }) with type one of
//                       'tabs' | 'plan' | 'goals' | 'selection' | 'results' |
//                       'scrub' | 'save' | 'workspace'
//   Store.edit(fn)      THE way to change the active plan. Snapshots it for
//                       undo, runs fn(plan) to mutate it, re-simulates on the
//                       next frame and schedules a save.
//   Store.editGoals(fn) the same for the goal list every plan shares.
//   Store.setWorkspace  'plans' (the builder), 'goals', 'analyze' or 'compare'.
//                       A preference of this browser, not part of any plan.
//
// Undo follows the workspace: in Goals it steps through goal edits, anywhere
// else through the active plan's.
//
// Editing is local-first: the plan in memory is the truth while the app is
// open, and the backend gets the whole plan 500 ms after the last change (and
// at once on unload). The engine runs in this process on every edit, so the
// outlook is always current with what is on the canvas.

(function () {
    const C = window.CitrineCatalog;
    const P = window.CitrinePlan;
    const Engine = window.CitrineEngine;

    const WORKSPACE_KEY = 'workspace';
    const WORKSPACES = ['plans', 'goals', 'analyze', 'compare'];
    // The goal list's key in the dirty set and the undo history. Plan ids
    // cannot contain a colon, so it never meets one.
    const GOALS = ':goals';

    const state = {
        status: null,
        workspace: WORKSPACES.includes(Prefs.get(WORKSPACE_KEY)) ? Prefs.get(WORKSPACE_KEY) : 'plans',
        goals: [],              // shared by every plan (plan.js, validateGoals)
        tabs: [],               // plan ids in tab order
        activeId: null,
        plan: null,
        selection: null,        // { kind: 'node' | 'link', id }, in the builder
        preview: null,          // preset id shown in the inspector before it is added
        previewIcon: null,      // icon picked for the previewed preset; the module is added wearing it
        results: null,
        scrub: null,            // month index under the chart cursor
        save: 'saved',          // 'saved' | 'saving' | 'error'
    };

    const plans = new Map();     // id → plan document
    const history = new Map();   // id → { undo: [], redo: [] }
    const dirty = new Set();
    const listeners = new Set();
    let saveTimer = null;
    let simQueued = false;
    let gesture = null;
    let coalesce = { key: null, at: 0 };

    const MAX_UNDO = 100;
    const SAVE_DELAY = 500;
    const COALESCE_MS = 1200;

    function emit(type) {
        for (const fn of listeners) {
            try { fn({ type }); } catch (e) { console.error('[store] listener failed', e); }
        }
    }

    function on(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    // ── Simulation ─────────────────────────────────────────────────────────

    function simulateNow() {
        simQueued = false;
        if (!state.plan) {
            state.results = null;
        } else {
            try {
                state.results = Engine.simulate(state.plan);
            } catch (e) {
                console.error('[store] simulation failed', e);
                state.results = null;
            }
        }
        emit('results');
    }

    function queueSimulation() {
        if (simQueued) return;
        simQueued = true;
        requestAnimationFrame(simulateNow);
    }

    // ── Undo ───────────────────────────────────────────────────────────────
    // A snapshot is the plan without its camera: undo puts modules back, it
    // does not move the view.

    function hist(id) {
        if (!history.has(id)) history.set(id, { undo: [], redo: [] });
        return history.get(id);
    }

    function snapshot() {
        const { view: _view, ...rest } = state.plan;
        return JSON.stringify(rest);
    }

    function pushUndo(snap, id = state.activeId) {
        const h = hist(id);
        h.undo.push(snap);
        if (h.undo.length > MAX_UNDO) h.undo.shift();
        h.redo.length = 0;
    }

    /** Mutate the active plan. `fn(plan)` returning false cancels the edit.
     *  `key` merges a run of edits to one field into a single undo step. */
    function edit(fn, { key = null } = {}) {
        if (!state.plan) return undefined;
        const now = performance.now();
        const merge = key !== null && key === coalesce.key && now - coalesce.at < COALESCE_MS;
        const before = merge || gesture ? null : snapshot();
        const result = fn(state.plan);
        if (result === false) return result;
        if (before !== null && before !== snapshot()) pushUndo(before);
        coalesce = { key, at: now };
        changed();
        return result;
    }

    function changed() {
        state.plan.updatedAt = new Date().toISOString();
        pruneSelection();
        markDirty(state.activeId);
        queueSimulation();
        emit('plan');
    }

    /** Mutate the shared goal list, as edit() does the plan: `fn(goals)`
     *  returning false cancels, `key` merges a run of edits to one field. */
    function editGoals(fn, { key = null } = {}) {
        const now = performance.now();
        const merge = key !== null && key === coalesce.key && now - coalesce.at < COALESCE_MS;
        const before = merge ? null : JSON.stringify(state.goals);
        const result = fn(state.goals);
        if (result === false) return result;
        if (before !== null && before !== JSON.stringify(state.goals)) pushUndo(before, GOALS);
        coalesce = { key, at: now };
        goalsChanged();
        return result;
    }

    function goalsChanged() {
        pruneSelection();
        markDirty(GOALS);
        emit('goals');
    }

    /** A drag: many moves, one undo step, no re-simulation while it runs
     *  (positions do not change the numbers). */
    function beginGesture() {
        if (state.plan && !gesture) gesture = snapshot();
    }

    function gestureMove(fn) {
        if (!gesture) return;
        fn(state.plan);
        emit('plan');
    }

    function endGesture() {
        if (!gesture) return;
        const before = gesture;
        gesture = null;
        if (before === snapshot()) return;
        pushUndo(before);
        coalesce = { key: null, at: 0 };
        state.plan.updatedAt = new Date().toISOString();
        markDirty(state.activeId);
        emit('plan');
    }

    function restore(snap) {
        const doc = JSON.parse(snap);
        doc.view = state.plan.view;
        plans.set(doc.id, doc);
        state.plan = doc;
        coalesce = { key: null, at: 0 };
        changed();
    }

    function restoreGoals(snap) {
        state.goals = JSON.parse(snap);
        coalesce = { key: null, at: 0 };
        goalsChanged();
    }

    /** The history undo works on now, with how to snapshot and restore it. */
    function undoTarget() {
        if (state.workspace === 'goals') return { h: hist(GOALS), snap: () => JSON.stringify(state.goals), put: restoreGoals };
        return state.plan ? { h: hist(state.activeId), snap: snapshot, put: restore } : null;
    }

    function undo() {
        const t = undoTarget();
        if (!t || !t.h.undo.length) return false;
        t.h.redo.push(t.snap());
        t.put(t.h.undo.pop());
        return true;
    }

    function redo() {
        const t = undoTarget();
        if (!t || !t.h.redo.length) return false;
        t.h.undo.push(t.snap());
        t.put(t.h.redo.pop());
        return true;
    }

    const canUndo = () => { const t = undoTarget(); return !!t && t.h.undo.length > 0; };
    const canRedo = () => { const t = undoTarget(); return !!t && t.h.redo.length > 0; };

    // ── Selection, scrub, camera ───────────────────────────────────────────

    function select(sel) {
        const hadPreview = state.preview !== null;
        state.preview = null;
        state.previewIcon = null;
        const same = (state.selection && sel && state.selection.kind === sel.kind && state.selection.id === sel.id)
            || (!state.selection && !sel);
        if (same) {
            if (hadPreview) emit('selection');
            return;
        }
        state.selection = sel;
        emit('selection');
    }

    /** Show a library module in the inspector without adding it to the plan. */
    function previewPreset(id) {
        if (state.preview === id) return;
        state.preview = id;
        state.previewIcon = null;
        state.selection = null;
        emit('selection');
    }

    /** Pick the icon the previewed module will be added with (null: its own). */
    function setPreviewIcon(icon) {
        const p = state.preview && C.preset(state.preview);
        if (!p) return;
        state.previewIcon = icon && icon !== p.icon && C.iconChoices(p).includes(icon) ? icon : null;
        emit('selection');
    }

    function pruneSelection() {
        const s = state.selection;
        if (!s) return;
        const list = !state.plan ? [] : s.kind === 'node' ? state.plan.nodes : state.plan.links;
        if (!list.some((x) => x.id === s.id)) {
            state.selection = null;
            emit('selection');
        }
    }

    /** Switch workspace. A selection belongs to the builder (a module, a link
     *  or a library preview), so leaving it lets the selection go. */
    function setWorkspace(w) {
        const next = WORKSPACES.includes(w) ? w : 'plans';
        if (state.workspace === next) return;
        state.workspace = next;
        Prefs.set(WORKSPACE_KEY, next);
        coalesce = { key: null, at: 0 };
        setScrub(null);
        emit('workspace');
        if (next !== 'plans' && (state.selection || state.preview)) select(null);
    }

    function setScrub(k) {
        if (state.scrub === k) return;
        state.scrub = k;
        emit('scrub');
    }

    /** Camera moves are saved with the plan but are not undoable edits. */
    function setView(view) {
        if (!state.plan) return;
        state.plan.view = view;
        markDirty(state.activeId);
    }

    // ── Saving ─────────────────────────────────────────────────────────────

    function setSave(s) {
        if (state.save === s) return;
        state.save = s;
        emit('save');
    }

    function markDirty(id) {
        if (!id) return;
        dirty.add(id);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flush, SAVE_DELAY);
    }

    let flushing = null;
    let lastError = null;

    async function flush() {
        clearTimeout(saveTimer);
        saveTimer = null;
        // A loop, not an if: another caller waiting on the same save may have
        // started the next one by the time this one wakes.
        while (flushing) await flushing;
        if (!dirty.size) return true;
        flushing = (async () => {
            setSave('saving');
            let ok = true;
            for (const id of [...dirty]) {
                const req = saveRequest(id);
                dirty.delete(id);
                if (!req) continue;
                const r = await api('PUT', req.url, req.body);
                if (r.ok) continue;
                ok = false;
                dirty.add(id);
                lastError = r.body && r.body.error;
                console.error('[store] save failed', r.status, r.body);
            }
            setSave(ok ? 'saved' : 'error');
            if (!ok) {
                const why = lastError ? ` (${lastError})` : '';
                UI.toast(`Changes could not be saved${why}.`, { type: 'error', action: { label: 'Retry', onClick: flush } });
            }
            return ok;
        })();
        try {
            return await flushing;
        } finally {
            flushing = null;
        }
    }

    /** What saving `id` (a plan id, or GOALS) sends: { url, body }, or null. */
    function saveRequest(id) {
        if (id === GOALS) return { url: '/api/goals', body: { goals: state.goals } };
        const doc = plans.get(id);
        return doc ? { url: `/api/plans/${encodeURIComponent(id)}`, body: { plan: doc } } : null;
    }

    // On unload there is no awaiting a reply. The request still reaches the
    // backend, which starts the write whether or not anyone is listening.
    window.addEventListener('beforeunload', () => {
        if (!dirty.size || !window.citrineApi) return;
        for (const id of dirty) {
            const req = saveRequest(id);
            if (req) window.citrineApi.request('PUT', req.url, req.body);
        }
    });

    // A browser tab can be closed, discarded or put to sleep without beforeunload
    // firing. Hiding is the last moment that is reliably announced, so save then.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });

    // ── Plans (tabs) ───────────────────────────────────────────────────────

    const planName = (id) => (plans.get(id) || {}).name || 'Plan';
    const getPlan = (id) => plans.get(id) || null;

    async function loadPlan(id) {
        if (plans.has(id)) return plans.get(id);
        const r = await api('GET', `/api/plans/${encodeURIComponent(id)}`);
        if (!r.ok) throw new Error(r.body.error || 'plan could not be loaded');
        plans.set(id, r.body.plan);
        return r.body.plan;
    }

    async function openPlan(id) {
        if (id === state.activeId && state.plan) return;
        const doc = await loadPlan(id);
        state.activeId = id;
        state.plan = doc;
        state.selection = null;
        state.preview = null;
        state.previewIcon = null;
        state.scrub = null;
        emit('tabs');
        emit('selection');
        emit('plan');
        simulateNow();
        persistTabs();
    }

    function persistTabs() {
        if (state.tabs.length) api('PUT', '/api/plans/order', { order: state.tabs, active: state.activeId });
    }

    async function addPlan(doc) {
        const r = await api('POST', '/api/plans', { plan: doc });
        if (!r.ok) {
            const cap = /^at most (\d+) plans$/.exec(r.body.error || '');
            UI.toast(cap ? `You can have at most ${cap[1]} plans.` : 'The plan could not be created.', { type: 'error' });
            return null;
        }
        plans.set(r.body.plan.id, r.body.plan);
        state.tabs.push(r.body.plan.id);
        await openPlan(r.body.plan.id);
        return r.body.plan;
    }

    function uniqueName(base) {
        const names = new Set(state.tabs.map(planName));
        if (!names.has(base)) return base;
        for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
    }

    function newPlan() {
        const start = state.plan ? state.plan.settings.start : P.ymNow();
        return addPlan(P.createPlan({ name: uniqueName('Untitled plan'), start }));
    }

    async function duplicatePlan(id) {
        await flush();
        const src = await loadPlan(id);
        return addPlan(P.cloneWithNewIds(src, uniqueName(`${src.name} copy`)));
    }

    async function renamePlan(id, name) {
        const clean = name.trim().slice(0, P.LIMITS.name);
        if (!clean) return;
        if (id === state.activeId) {
            edit((plan) => { plan.name = clean; });
        } else {
            const doc = await loadPlan(id);
            doc.name = clean;
            markDirty(id);
        }
        emit('tabs');
    }

    async function deletePlan(id) {
        await flush();
        const r = await api('DELETE', `/api/plans/${encodeURIComponent(id)}`);
        if (!r.ok) {
            UI.toast('The plan could not be deleted.', { type: 'error' });
            return;
        }
        plans.delete(id);
        history.delete(id);
        dirty.delete(id);
        state.tabs = state.tabs.filter((x) => x !== id);
        if (state.activeId === id) {
            state.activeId = null;
            state.plan = null;
            if (r.body.active) await openPlan(r.body.active);
            else await newPlan();
        } else {
            emit('tabs');
        }
    }

    function reorderTabs(order) {
        state.tabs = order.slice();
        emit('tabs');
        persistTabs();
    }

    /** Import a plan file the user picks, and open it. Resolves to the plan,
     *  or null when nothing was imported (cancelled, or refused). */
    async function importPlan() {
        const r = await api('POST', '/api/plans/import');
        if (!r.ok) {
            UI.toast(r.body.error ? `Not imported: ${r.body.error}.` : 'The plan could not be imported.', { type: 'error' });
            return null;
        }
        if (r.body.canceled) return null;
        plans.set(r.body.plan.id, r.body.plan);
        state.tabs.push(r.body.plan.id);
        await openPlan(r.body.plan.id);
        // An older plan file may have brought goals of its own into the shared list.
        await loadGoals().catch((e) => console.error('[store] goals could not be reloaded', e));
        UI.toast(`Imported ${r.body.plan.name}.`, { type: 'success' });
        return r.body.plan;
    }

    async function exportPlan(id) {
        await flush();
        const r = await api('POST', `/api/plans/${encodeURIComponent(id)}/export`);
        if (!r.ok) UI.toast('The plan could not be exported.', { type: 'error' });
        else if (!r.body.canceled) UI.toast('Plan exported.', { type: 'success' });
    }

    /** Load the tabs and open the active plan. A fresh install gets a blank
     *  plan, which opens on the empty-plan card. Returns false while another tab is editing. */
    async function boot() {
        const st = await api('GET', '/api/status');
        if (!st.ok) throw new Error('backend unavailable');
        state.status = st.body;
        if (st.body.busy) return false;
        const r = await api('GET', '/api/plans');
        if (!r.ok) throw new Error(r.body.error || 'plans could not be listed');
        state.tabs = r.body.order.slice();
        // Plans are small; loading every one up front gives the navigation its
        // names, makes switching plans instant and lets Compare run them all.
        await Promise.all([...state.tabs.map(loadPlan), loadGoals()]);
        // Signing in starts on the first plan, not wherever the last visit ended.
        let signedIn = false;
        try {
            signedIn = sessionStorage.getItem('signed-in') === '1';
            sessionStorage.removeItem('signed-in');
        } catch { /* no session storage: the app opens where it was left */ }
        if (!state.tabs.length) {
            await newPlan();
        } else {
            if (signedIn) setWorkspace('plans');
            await openPlan(signedIn ? state.tabs[0] : (r.body.active || state.tabs[0]));
        }
        return true;
    }

    // ── Module and link actions ────────────────────────────────────────────
    // Domain operations shared by the canvas, the library and the inspector.

    const node = (id) => state.plan && state.plan.nodes.find((n) => n.id === id);
    const link = (id) => state.plan && state.plan.links.find((l) => l.id === id);

    function addNode(presetId, x, y) {
        let created = null;
        edit((plan) => {
            if (plan.nodes.length >= P.LIMITS.nodes) {
                UI.toast(`A plan holds at most ${P.LIMITS.nodes} modules.`, { type: 'error' });
                return false;
            }
            created = P.createNode(plan, presetId, x, y);
            if (state.preview === presetId && state.previewIcon) created.icon = state.previewIcon;
            plan.nodes.push(created);
            return true;
        });
        if (created) select({ kind: 'node', id: created.id });
        return created;
    }

    /** A copy of one module beside it, named as a copy, and selected. */
    function duplicateNode(id) {
        const snap = copyNodes([id]);
        if (!snap) return null;
        snap.nodes[0].name = `${snap.nodes[0].name} copy`.slice(0, P.LIMITS.name);
        const [made] = pasteNodes(snap, 32);
        if (!made) return null;
        select({ kind: 'node', id: made });
        return node(made);
    }

    /** Copies of `ids` and the links among them, ready for pasteNodes. */
    function copyNodes(ids) {
        const plan = state.plan;
        if (!plan) return null;
        const want = new Set(ids);
        const nodes = plan.nodes.filter((n) => want.has(n.id));
        if (!nodes.length) return null;
        const links = plan.links.filter((l) => want.has(l.from) && want.has(l.to));
        return JSON.parse(JSON.stringify({ nodes, links }));
    }

    /** Paste a copyNodes snapshot into the open plan, `offset` px from where it
     *  was copied, with fresh ids. Returns the new node ids. */
    function pasteNodes(snap, offset) {
        if (!snap || !state.plan) return [];
        const ids = new Map();
        const made = [];
        edit((plan) => {
            if (plan.nodes.length + snap.nodes.length > P.LIMITS.nodes) {
                UI.toast(`A plan holds at most ${P.LIMITS.nodes} modules.`, { type: 'error' });
                return false;
            }
            if (plan.links.length + snap.links.length > P.LIMITS.links) {
                UI.toast(`A plan holds at most ${P.LIMITS.links} links.`, { type: 'error' });
                return false;
            }
            for (const src of snap.nodes) {
                const n = JSON.parse(JSON.stringify(src));
                ids.set(src.id, n.id = P.newId('n'));
                n.x += offset;
                n.y += offset;
                plan.nodes.push(n);
                made.push(n.id);
            }
            // Cash back follows a copied account; to one left behind it still
            // goes if that account is in this plan (the plan clears it if not).
            for (const n of plan.nodes.filter((x) => made.includes(x.id))) {
                if (n.params && ids.has(n.params.cashBackTo)) n.params.cashBackTo = ids.get(n.params.cashBackTo);
            }
            for (const src of snap.links) {
                const l = JSON.parse(JSON.stringify(src));
                l.id = P.newId('l');
                l.from = ids.get(src.from);
                l.to = ids.get(src.to);
                plan.links.push(l);
            }
            return true;
        });
        return made;
    }

    /** Remove modules and every link touching them, as one undo step. */
    function removeNodes(ids) {
        const gone = new Set(ids);
        edit((plan) => {
            plan.nodes = plan.nodes.filter((n) => !gone.has(n.id));
            plan.links = plan.links.filter((l) => !gone.has(l.from) && !gone.has(l.to));
            // A card that paid its cash back into a removed account credits itself again.
            for (const n of plan.nodes) if (n.params && gone.has(n.params.cashBackTo)) n.params.cashBackTo = null;
        });
    }

    const removeNode = (id) => removeNodes([id]);

    /** Link two modules on `basis`, or on the usual (else next free) one. */
    /** `sides` ({ fromSide, toSide }) pins the dots the link is drawn between. */
    function connect(fromId, toId, basis = null, sides = null) {
        const check = P.canConnect(state.plan, fromId, toId, basis);
        if (!check.ok) return null;
        let created = null;
        edit((plan) => {
            if (plan.links.length >= P.LIMITS.links) return false;
            created = P.createLink(plan, fromId, toId, basis);
            if (sides) Object.assign(created, sides);
            plan.links.push(created);
            return true;
        });
        if (created) select({ kind: 'link', id: created.id });
        return created;
    }

    /** Drag a link's receiving end to another module, or to another dot of the
     *  same one. Returns { ok } or { ok: false, reason }. */
    function reconnect(id, toId, toSide) {
        let result = { ok: false, reason: 'missing' };
        edit((plan) => {
            const l = plan.links.find((x) => x.id === id);
            if (!l) return false;
            result = P.reconnect(plan, l, toId, toSide);
            return result.ok;
        });
        return result;
    }

    function removeLink(id) {
        edit((plan) => { plan.links = plan.links.filter((l) => l.id !== id); });
    }

    // ── Goals ──────────────────────────────────────────────────────────────
    // One list, shared by every plan. Edited in the Goals workspace; each plan
    // is measured against it in Analyze.

    const goal = (id) => state.goals.find((g) => g.id === id);

    /** The colour a new goal takes: the next one no other goal wears (then they repeat). */
    function nextGoalColor() {
        const goals = state.goals;
        const free = P.GOAL_COLORS.filter((c) => !goals.some((g) => g.color === c));
        return free[0] || P.GOAL_COLORS[goals.length % P.GOAL_COLORS.length];
    }

    /** Add a goal, from `fields` (its rule, name and colour; plan.js fills in
     *  the rest). Returns it, or null at the limit. */
    function addGoal(fields = {}) {
        let created = null;
        editGoals((goals) => {
            if (goals.length >= P.LIMITS.goals) {
                UI.toast(`You can set at most ${P.LIMITS.goals} goals.`, { type: 'error' });
                return false;
            }
            created = P.createGoal({ color: nextGoalColor(), ...fields });
            goals.push(created);
            return true;
        });
        return created;
    }

    function removeGoal(id) {
        editGoals((goals) => {
            const at = goals.findIndex((g) => g.id === id);
            if (at < 0) return false;
            goals.splice(at, 1);
            return true;
        });
    }

    async function loadGoals() {
        const r = await api('GET', '/api/goals');
        if (!r.ok) throw new Error(r.body.error || 'goals could not be loaded');
        state.goals = r.body.goals;
        emit('goals');
    }

    window.Store = {
        state, on, edit, beginGesture, gestureMove, endGesture, undo, redo, canUndo, canRedo,
        select, setScrub, setView, flush, boot, openPlan, newPlan, addPlan, duplicatePlan,
        renamePlan, deletePlan, reorderTabs, importPlan, exportPlan, planName, getPlan,
        node, link, previewPreset, setPreviewIcon, addNode, duplicateNode, copyNodes, pasteNodes, removeNode, removeNodes,
        connect, reconnect, removeLink, goal, editGoals, addGoal, nextGoalColor, removeGoal, setWorkspace,
    };
}());

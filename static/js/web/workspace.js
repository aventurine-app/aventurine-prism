'use strict';

// ─── workspace.js ───────────────────────────────────────────────────────────
// The user's plans, kept in memory and mirrored to browser storage. It answers
// the same questions the desktop backend's workspace did (list, get, add, put,
// delete, reorder), so the app's code does not know where plans live.
//
// Reads are synchronous and come from memory. Writes are async functions: they
// validate and update memory right away, start the storage write in the same
// tick, and resolve once it is stored. Starting the write at once is what lets
// a save issued while the page is closing still reach the database. If a write
// fails, add, delete and reorder undo their memory change; a failed put is left
// for the caller to retry, which the store does.
//
// Storage holds one record per plan plus the tab order, so saving an edit
// writes one plan, not all of them. A stored plan that fails validation (say,
// one saved by a newer build) is left untouched in storage and only counted.
//
// `storage` is { load() -> { plans, meta }, write({ put, remove, meta }) }.
// Dual-environment: window.PrismWeb.createWorkspace in the page, CommonJS for
// tests, which pass an in-memory storage.

(function (root, factory) {
    const isNode = typeof module === 'object' && module.exports;
    const { ApiError } = isNode ? require('./api-error.js') : root.PrismWeb;
    const Plan = isNode ? require('../sim/plan.js') : root.CitrinePlan;
    const api = factory(Plan, ApiError);
    if (isNode) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, api);
}(typeof self !== 'undefined' ? self : this, function (Plan, ApiError) {

    const MAX_PLANS = 100;

    function planMeta(p) {
        return { id: p.id, name: p.name, updatedAt: p.updatedAt, modules: p.nodes.length };
    }

    /** What went wrong with storage, in words the app can show. */
    function storageError(e) {
        return e && e.name === 'QuotaExceededError'
            ? new ApiError('browser storage is full', 507)
            : new ApiError('browser storage failed', 500);
    }

    function createWorkspace({ storage, clock = () => new Date(), logger = console }) {
        const plans = new Map();
        let order = [];
        let active = null;
        let unreadable = 0;

        const stamp = () => clock().toISOString();
        const tabMeta = () => ({ order: order.slice(), active });

        async function persist(change, undo) {
            try {
                await storage.write(change);
            } catch (e) {
                if (undo) undo();
                logger.error('[workspace] write failed:', e);
                throw storageError(e);
            }
        }

        function validated(raw) {
            try {
                return Plan.validatePlan(raw);
            } catch (e) {
                if (e instanceof Plan.PlanError) throw new ApiError(e.message, 422);
                throw e;
            }
        }

        function find(id) {
            const p = plans.get(id);
            if (!p) throw new ApiError('plan not found', 404);
            return p;
        }

        // ── Loading ────────────────────────────────────────────────────────

        async function init() {
            const stored = await storage.load();
            const readable = [];
            for (const raw of stored.plans) {
                try {
                    readable.push(Plan.validatePlan(raw));
                } catch (e) {
                    unreadable += 1;
                    logger.warn('[workspace] a stored plan was left unread:', e.message);
                }
            }
            // Plans the saved order does not mention follow it, oldest first.
            readable.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
            for (const p of readable) plans.set(p.id, p);

            const saved = stored.meta && Array.isArray(stored.meta.order) ? stored.meta.order : [];
            const seen = new Set();
            for (const id of saved) {
                if (plans.has(id) && !seen.has(id)) {
                    seen.add(id);
                    order.push(id);
                }
            }
            for (const p of readable) if (!seen.has(p.id)) order.push(p.id);
            active = stored.meta && order.includes(stored.meta.active) ? stored.meta.active : (order[0] || null);
        }

        // ── Reads ──────────────────────────────────────────────────────────

        function listPlans() {
            return { plans: order.map((id) => planMeta(find(id))), order: order.slice(), active };
        }

        function getPlan(id) {
            return find(id);
        }

        function status() {
            return { storage: 'browser', encrypted: false, locked: false, plans: plans.size, quarantined: unreadable };
        }

        // ── Writes ─────────────────────────────────────────────────────────

        async function addPlan(raw) {
            const plan = validated(raw);
            if (plans.size >= MAX_PLANS) throw new ApiError(`at most ${MAX_PLANS} plans`, 409);
            if (plans.has(plan.id)) throw new ApiError('plan already exists', 409);
            plan.updatedAt = stamp();
            const prevActive = active;
            plans.set(plan.id, plan);
            order.push(plan.id);
            active = plan.id;
            await persist({ put: [plan], meta: tabMeta() }, () => {
                plans.delete(plan.id);
                order = order.filter((id) => id !== plan.id);
                active = prevActive;
            });
            return plan;
        }

        /** Add a plan from an exported file. Ids are regenerated, so importing
         *  the same file twice gives two independent plans. */
        function importPlan(raw) {
            return addPlan(Plan.cloneWithNewIds(validated(raw)));
        }

        async function putPlan(id, raw) {
            const plan = validated(raw);
            if (plan.id !== id) throw new ApiError('plan id mismatch', 400);
            const prev = find(id);
            plan.createdAt = prev.createdAt;
            plan.updatedAt = stamp();
            plans.set(id, plan);
            await persist({ put: [plan] });
            return { updatedAt: plan.updatedAt };
        }

        async function deletePlan(id) {
            const prev = find(id);
            const prevOrder = order;
            const prevActive = active;
            const at = order.indexOf(id);
            plans.delete(id);
            order = order.filter((x) => x !== id);
            if (active === id) active = order[Math.min(at, order.length - 1)] || null;
            const result = { order: order.slice(), active };
            await persist({ remove: [id], meta: tabMeta() }, () => {
                plans.set(id, prev);
                order = prevOrder;
                active = prevActive;
            });
            return result;
        }

        async function setTabs({ order: next, active: nextActive } = {}) {
            if (!Array.isArray(next) || next.length !== order.length
                || new Set(next).size !== next.length || !next.every((id) => plans.has(id))) {
                throw new ApiError('order must list every plan once', 400);
            }
            if (nextActive != null && !next.includes(nextActive)) throw new ApiError('unknown active plan', 400);
            const prevOrder = order;
            const prevActive = active;
            order = next.slice();
            active = nextActive ?? active;
            const result = { order: order.slice(), active };
            await persist({ meta: tabMeta() }, () => {
                order = prevOrder;
                active = prevActive;
            });
            return result;
        }

        return { init, status, listPlans, getPlan, addPlan, importPlan, putPlan, deletePlan, setTabs };
    }

    return { createWorkspace, MAX_PLANS };
}));

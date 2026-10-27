'use strict';

// An in-memory stand-in for static/js/web/storage.js (same load/write methods),
// so the workspace and backend are tested without a browser. It records every
// write at the moment write() is CALLED, which lets a test check that a save
// starts in the same tick as the request.

function createMemoryStorage({ plans = [], meta = null, goals = null } = {}) {
    const records = new Map(plans.map((p) => [p.id, structuredClone(p)]));
    let tabs = meta && structuredClone(meta);
    let shared = goals && structuredClone(goals);

    const storage = {
        writes: [],
        /** Set to an Error to make the next write reject with it. */
        failNext: null,

        async load() {
            return {
                plans: [...records.values()].map((p) => structuredClone(p)),
                meta: tabs && structuredClone(tabs),
                goals: shared && structuredClone(shared),
            };
        },

        write(change) {
            storage.writes.push(change);
            if (storage.failNext) {
                const error = storage.failNext;
                storage.failNext = null;
                return Promise.reject(error);
            }
            for (const p of change.put || []) records.set(p.id, structuredClone(p));
            for (const id of change.remove || []) records.delete(id);
            if (change.meta) tabs = structuredClone(change.meta);
            if (change.goals) shared = structuredClone(change.goals);
            return Promise.resolve();
        },

        /** What is stored right now. */
        snapshot: () => ({ plans: [...records.values()], meta: tabs, goals: shared }),
    };
    return storage;
}

module.exports = { createMemoryStorage };

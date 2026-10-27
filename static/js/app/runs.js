'use strict';

// ─── runs.js ────────────────────────────────────────────────────────────────
// Every plan's run of the engine, for the views that look at more than the
// open plan (Compare, the goal board, the goal inspector). A plan is
// simulated once per version of it (its updatedAt); the open plan's run is
// the store's own.
//
//   Runs.all()      [{ plan, results }] for every plan, in navigation order;
//                   results is null for a plan the engine failed on

(function () {
    const cache = new Map();   // plan id → { updatedAt, results }

    /** One plan's results, or null if the engine failed on it. */
    function of(plan) {
        if (plan === Store.state.plan && Store.state.results) return Store.state.results;
        const hit = cache.get(plan.id);
        if (hit && hit.updatedAt === plan.updatedAt) return hit.results;
        let results = null;
        try {
            results = window.CitrineEngine.simulate(plan);
        } catch (e) {
            console.error('[runs] simulation failed', plan.id, e);
        }
        cache.set(plan.id, { updatedAt: plan.updatedAt, results });
        return results;
    }

    function all() {
        return Store.state.tabs.map((id) => Store.getPlan(id)).filter(Boolean)
            .map((plan) => ({ plan, results: of(plan) }));
    }

    // A deleted plan's run goes with it.
    Store.on((c) => {
        if (c.type !== 'tabs') return;
        for (const id of cache.keys()) if (!Store.state.tabs.includes(id)) cache.delete(id);
    });

    window.Runs = { all };
}());

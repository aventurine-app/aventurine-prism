'use strict';

// ─── storage.js ─────────────────────────────────────────────────────────────
// IndexedDB behind workspace.js. Two object stores:
//
//   plans   one record per plan, keyed by plan id
//   meta    'tabs': { order, active }, the plans' order in the navigation
//           'goals': [goal], the goals every plan is measured against
//
// `write` puts, deletes and updates the order and goals in ONE transaction, so
// a crash can never leave a plan without its place in the order, or the reverse.
// Browser only; tests use an in-memory stand-in with the same two methods.

(function () {
    const DB_NAME = 'aventurine-prism';
    const DB_VERSION = 1;
    const TABS_KEY = 'tabs';
    const GOALS_KEY = 'goals';

    /** Resolve with a request's result, reject with its error. */
    function result(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function openDatabase(factory) {
        return new Promise((resolve, reject) => {
            const request = factory.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                db.createObjectStore('plans', { keyPath: 'id' });
                db.createObjectStore('meta');
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('the plans database is blocked by another tab'));
        });
    }

    /** Open (creating if needed) the plans database. */
    async function openIndexedDb(factory = indexedDB) {
        const db = await openDatabase(factory);
        // A newer build in another tab wants to upgrade: step aside.
        db.onversionchange = () => db.close();

        async function load() {
            const tx = db.transaction(['plans', 'meta'], 'readonly');
            const [plans, meta, goals] = await Promise.all([
                result(tx.objectStore('plans').getAll()),
                result(tx.objectStore('meta').get(TABS_KEY)),
                result(tx.objectStore('meta').get(GOALS_KEY)),
            ]);
            // No goals record at all (not even an empty one) means they were never shared yet.
            return { plans, meta: meta || null, goals: goals === undefined ? null : goals };
        }

        /** Apply { put: [plan], remove: [id], meta, goals } atomically. The
         *  transaction is created before this returns, so callers may fire and forget. */
        function write({ put = [], remove = [], meta = null, goals = null }) {
            return new Promise((resolve, reject) => {
                const tx = db.transaction(['plans', 'meta'], 'readwrite');
                const plans = tx.objectStore('plans');
                for (const plan of put) plans.put(plan);
                for (const id of remove) plans.delete(id);
                if (meta) tx.objectStore('meta').put(meta, TABS_KEY);
                if (goals) tx.objectStore('meta').put(goals, GOALS_KEY);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('the write was aborted'));
            });
        }

        return { load, write };
    }

    window.PrismWeb = Object.assign(window.PrismWeb || {}, { openIndexedDb });
}());

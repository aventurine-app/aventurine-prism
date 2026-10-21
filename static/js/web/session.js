'use strict';

// ─── session.js ─────────────────────────────────────────────────────────────
// One editing tab at a time. Each tab loads every plan into memory and writes
// back what it changes, so two tabs would overwrite each other's edits. The
// desktop app avoided this with a single-instance lock; the browser's
// equivalent is a Web Lock held for as long as the page lives (the browser
// releases it when the tab closes or crashes).
//
// A tab that finds the lock taken does not fail: `acquired` settles when the
// other tab lets go, and only then does the app read the plans, so it sees
// that tab's final saves.
//
// Dual-environment: window.PrismWeb.claimEditor in the page, CommonJS for tests
// (which pass a fake `locks`).

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, api);
}(typeof self !== 'undefined' ? self : this, function () {

    const LOCK_NAME = 'aventurine-prism-editor';

    /** A lock callback result that never settles: the lock is held until the page goes. */
    const holdForever = () => new Promise(() => {});

    /**
     * Try to become the editing tab.
     * @param {LockManager|undefined} locks navigator.locks
     * @returns {Promise<{ owned: boolean, acquired: Promise<void> }>} `owned` is
     *   whether this tab got the lock at once; `acquired` settles when it has it.
     */
    function claimEditor(locks) {
        // No Web Locks (an old browser): carry on without the guard.
        if (!locks) return Promise.resolve({ owned: true, acquired: Promise.resolve() });
        return new Promise((resolve) => {
            locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
                if (lock) {
                    resolve({ owned: true, acquired: Promise.resolve() });
                    return holdForever();
                }
                const acquired = new Promise((granted) => {
                    locks.request(LOCK_NAME, () => {
                        granted();
                        return holdForever();
                    });
                });
                resolve({ owned: false, acquired });
                return undefined;
            });
        });
    }

    return { claimEditor, EDITOR_LOCK_NAME: LOCK_NAME };
}));

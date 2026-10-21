'use strict';

// ─── prefs.js ───────────────────────────────────────────────────────────────
// Per-machine interface preferences (theme, number format, panel layout) in
// localStorage. Storage can be unavailable or full: a read then falls back
// and a write is simply not kept, so no caller needs a try/catch of its own.
// theme-init.js reads its keys directly, since it runs in <head> before this.
//
//   Prefs.get('outlook-view', 'worth')
//   Prefs.set('outlook-view', 'table')

(function () {
    function get(key, fallback = null) {
        try {
            const v = localStorage.getItem(key);
            return v === null ? fallback : v;
        } catch {
            return fallback;
        }
    }

    function set(key, value) {
        try { localStorage.setItem(key, value); } catch { /* not kept */ }
    }

    window.Prefs = { get, set };
}());

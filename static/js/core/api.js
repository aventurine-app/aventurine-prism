'use strict';

// ─── api.js ─────────────────────────────────────────────────────────────────
// The one data seam. Every call to the backend goes through api(), which
// crosses IPC (window.citrineApi from preload.js) to the in-process backend.
// No HTTP, no socket, no port.
//
//   const r = await api('GET', '/api/plans');
//   if (r.ok) use(r.body); else show(r.body.error);
//
// The backend's contract is { status, body }; this adds `ok` for 2xx. A
// failure of the bridge itself comes back as status 0, never as a throw, so
// callers handle one shape.

(function () {
    async function api(method, url, body = null) {
        const bridge = window.citrineApi;
        if (!bridge) return { ok: false, status: 0, body: { ok: false, error: 'backend unavailable' } };
        try {
            const r = await bridge.request(method, url, body);
            return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body || {} };
        } catch (e) {
            console.error('[api]', method, url, e);
            return { ok: false, status: 0, body: { ok: false, error: 'backend unavailable' } };
        }
    }

    window.api = api;
}());

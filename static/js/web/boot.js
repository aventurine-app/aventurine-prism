'use strict';

// ─── boot.js ────────────────────────────────────────────────────────────────
// Installs window.citrineApi.request(method, url, body), which core/api.js
// calls for everything the app reads or saves. Order of events:
//
//   1. claim the editing-tab lock (session.js)
//   2. once held, open IndexedDB and load the plans (storage.js, workspace.js)
//   3. answer requests through the router (backend.js)
//
// Until the plans are loaded, requests wait. Two answers are given early:
//   GET /api/status   says "busy" if another tab is editing, so the app can
//                     show its waiting screen instead of hanging
//   GET /api/ready    waits until this tab has the plans, for that screen

(function () {
    const { claimEditor, openIndexedDb, createWorkspace, createBackend, fileDialogs } = window.PrismWeb;

    const BUSY_STATUS = { storage: 'browser', busy: true };
    const UNAVAILABLE = { status: 503, body: { ok: false, error: 'storage unavailable' } };

    let backend = null;
    const claimed = claimEditor(navigator.locks);

    async function open() {
        const claim = await claimed;
        await claim.acquired;
        const workspace = createWorkspace({ storage: await openIndexedDb() });
        await workspace.init();
        backend = createBackend({ workspace, files: fileDialogs });
        return backend;
    }

    const ready = open();
    ready.catch((e) => console.error('[boot] the plans could not be opened:', e));

    /** Requests that arrive before the plans are loaded. */
    async function whenReady(method, url, body) {
        const claim = await claimed;
        if (method === 'GET' && url === '/api/status' && !claim.owned) {
            return { status: 200, body: BUSY_STATUS };
        }
        try {
            const loaded = await ready;
            return loaded.dispatch(method, url === '/api/ready' ? '/api/status' : url, body);
        } catch {
            return UNAVAILABLE;
        }
    }

    window.citrineApi = Object.freeze({
        request: (method, url, body) => (backend ? backend.dispatch(method, url, body) : whenReady(method, url, body)),
    });
}());

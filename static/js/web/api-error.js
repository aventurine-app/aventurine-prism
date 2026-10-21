'use strict';

// ─── api-error.js ───────────────────────────────────────────────────────────
// The failure type of the browser backend (static/js/web/). A handler throws
// ApiError(message, status) and backend.js turns it into a { status, body }
// answer.
//
// Dual-environment: window.PrismWeb.ApiError in the page, CommonJS for tests.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, api);
}(typeof self !== 'undefined' ? self : this, function () {

    class ApiError extends Error {
        constructor(message, status = 400, extra = null) {
            super(message);
            this.status = status;
            this.extra = extra;
        }
    }

    return { ApiError };
}));

'use strict';

// ─── plan-files.js ──────────────────────────────────────────────────────────
// The exported plan file: plain JSON the user keeps, so it must stay readable
// without Aventurine Prism. Pure functions only; saving and picking the file
// is file-dialogs.js.
//
//   { format: 'citrine-plan', version: 1, exportedAt, plan }
//
// The format name predates the product name and is kept, so plan files from
// the desktop app still import. A bare plan object (no wrapper) imports too.
//
// Dual-environment: window.PrismWeb.PlanFiles in the page, CommonJS for tests.

(function (root, factory) {
    const isNode = typeof module === 'object' && module.exports;
    const { ApiError } = isNode ? require('./api-error.js') : root.PrismWeb;
    const api = factory(ApiError);
    if (isNode) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, api);
}(typeof self !== 'undefined' ? self : this, function (ApiError) {

    const PLAN_FILE_FORMAT = 'citrine-plan';
    const FILE_VERSION = 1;
    const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

    /** The text to save for one plan. */
    function serialize(plan, exportedAt = new Date()) {
        return JSON.stringify({
            format: PLAN_FILE_FORMAT,
            version: FILE_VERSION,
            exportedAt: exportedAt.toISOString(),
            plan,
        }, null, 2);
    }

    /** The plan inside a file's text, still unvalidated (the workspace does that). */
    function parse(text) {
        if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) {
            throw new ApiError('file is too large to be a plan', 422);
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new ApiError('not an Aventurine Prism plan file', 422);
        }
        return parsed && parsed.format === PLAN_FILE_FORMAT ? parsed.plan : parsed;
    }

    /** A file name for a plan: its name without characters file systems refuse. */
    function fileName(planName) {
        // eslint-disable-next-line no-control-regex
        const safe = String(planName || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 60);
        return `${safe || 'plan'}.json`;
    }

    return { PlanFiles: { PLAN_FILE_FORMAT, MAX_IMPORT_BYTES, serialize, parse, fileName } };
}));

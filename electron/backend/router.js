'use strict';

// Route table matcher + dispatcher. The IPC layer carries HTTP-shaped requests
// ({ method, path, body }), so every renderer call site reads like a fetch()
// and this module is the URL map. Same contract as Aventurine's router.
//
// Patterns name their params inline: '/api/plans/<id>'. A param matches one
// path segment.
//
// Dispatch contract (what static/js/core/api.js relies on):
//   dispatch(ctx, method, url, body) -> Promise<{ status, body }>
//   - handler returns (or resolves to) a body object  -> 200
//   - handler throws ApiError(msg, status[, extra])   -> { ok:false, error:msg, ...extra }
//   - no route                                         -> 404
//   - plans file locked, path outside /api/file/       -> 423 { error:'locked' }

const fs = require('fs');
const path = require('path');

class ApiError extends Error {
    constructor(message, status = 400, extra = null) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

// Cap the error log so a failure that repeats on every request cannot fill
// the disk. Past it the file is truncated rather than rotated: the useful
// entries are the recent ones.
const ERROR_LOG_MAX_BYTES = 1 << 20;

/** Keep an unexpected failure in <data dir>/backend-errors.log so it survives
 *  a desktop launch where nobody sees the console. Best effort only. */
function logBackendError(method, reqPath, e) {
    console.error(`[backend] ${method} ${reqPath} failed:`, e);
    try {
        const dir = process.env.CITRINE_DATA_DIR;
        if (!dir) return;
        const file = path.join(dir, 'backend-errors.log');
        let size = 0;
        try { size = fs.statSync(file).size; } catch { /* first write */ }
        const entry = `${new Date().toISOString()} ${method} ${reqPath}\n${(e && e.stack) || e}\n\n`;
        if (size + entry.length > ERROR_LOG_MAX_BYTES) fs.writeFileSync(file, entry, { mode: 0o600 });
        else fs.appendFileSync(file, entry, { mode: 0o600 });
        fs.chmodSync(file, 0o600);
    } catch {
        // disk full or read-only data dir: nothing more can be done
    }
}

function compile(pattern) {
    const names = [];
    const src = pattern
        .split('/')
        .map((seg) => {
            const m = /^<([A-Za-z_][A-Za-z0-9_]*)>$/.exec(seg);
            if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            names.push(m[1]);
            return '([^/]+)';
        })
        .join('/');
    return { regex: new RegExp(`^${src}$`), names };
}

function buildRouter(routes) {
    const compiled = routes.map(([method, pattern, fn]) => ({ method, fn, ...compile(pattern) }));

    async function dispatch(ctx, method, url, body) {
        const qIdx = url.indexOf('?');
        const reqPath = qIdx === -1 ? url : url.slice(0, qIdx);
        const query = Object.fromEntries(new URLSearchParams(qIdx === -1 ? '' : url.slice(qIdx + 1)));

        // While the plans file is encrypted and not yet unlocked, only the
        // file routes (status, unlock) answer. Segment-anchored: this is a deny
        // gate, so '/api/file' must never exempt a future '/api/filesomething'.
        const underFile = reqPath === '/api/file' || reqPath.startsWith('/api/file/');
        if (ctx.workspace.isLocked() && reqPath.startsWith('/api/') && !underFile) {
            return { status: 423, body: { ok: false, error: 'locked' } };
        }

        for (const r of compiled) {
            if (r.method !== method) continue;
            const m = r.regex.exec(reqPath);
            if (!m) continue;
            try {
                const params = {};
                r.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
                const result = await r.fn(ctx, { params, query, body: body ?? null });
                return { status: 200, body: result };
            } catch (e) {
                if (e instanceof ApiError) {
                    return { status: e.status, body: { ok: false, error: e.message, ...(e.extra || {}) } };
                }
                if (e instanceof URIError) {
                    return { status: 400, body: { ok: false, error: 'bad request' } };
                }
                // Unexpected: log it, answer with a generic 500 that leaks no internals.
                logBackendError(method, reqPath, e);
                return { status: 500, body: { ok: false, error: 'internal error' } };
            }
        }
        return { status: 404, body: { ok: false, error: 'not found' } };
    }

    return { dispatch };
}

module.exports = { ApiError, buildRouter };

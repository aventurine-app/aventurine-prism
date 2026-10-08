'use strict';

// The plans file itself: where it is, whether it is encrypted, unlocking it,
// and turning encryption on, off or onto a new password. These are the only
// routes that answer while the file is locked (see router.js).

function status(ctx) {
    return ctx.workspace.status();
}

function unlock(ctx, { body }) {
    return ctx.workspace.unlock(body && body.password);
}

function lock(ctx) {
    return ctx.workspace.lock();
}

function encryption(ctx, { body }) {
    const b = body || {};
    return ctx.workspace.setEncryption({ action: b.action, current: b.current, password: b.password });
}

const routes = [
    ['GET',  '/api/file/status', status],
    ['POST', '/api/file/unlock', unlock],
    ['POST', '/api/file/lock', lock],
    ['POST', '/api/file/encryption', encryption],
];

module.exports = { routes };

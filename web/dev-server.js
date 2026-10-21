'use strict';

// ─── dev-server.js ──────────────────────────────────────────────────────────
// Serves the web app from source for development: the assembled page at /,
// everything under static/ at /static/. Nothing is cached, so an edit shows on
// reload with no build. Listens on 127.0.0.1 only.
//
//   node web/dev-server.js        (PORT=5174 by default)

const fs = require('fs');
const http = require('http');
const path = require('path');
const { assemblePage, STATIC_DIR } = require('./assemble');

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
};

/** Resolve a URL path inside `root`, or null if it would leave it ('..', absolute paths). */
function safeJoin(root, urlPath) {
    const resolved = path.resolve(root, '.' + path.posix.normalize('/' + urlPath));
    return resolved.startsWith(root + path.sep) ? resolved : null;
}

function send(res, status, type, body) {
    res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
}

function createServer() {
    return http.createServer((req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            send(res, 405, TYPES['.html'], 'method not allowed');
            return;
        }
        let pathname;
        try {
            pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        } catch {
            send(res, 400, TYPES['.html'], 'bad request');
            return;
        }

        if (pathname === '/') {
            try {
                send(res, 200, TYPES['.html'], assemblePage());
            } catch (e) {
                console.error('[dev-server] page could not be assembled:', e);
                send(res, 500, TYPES['.html'], 'page could not be assembled');
            }
            return;
        }

        const file = pathname.startsWith('/static/') ? safeJoin(STATIC_DIR, pathname.slice('/static/'.length)) : null;
        fs.readFile(file || '', (err, data) => {
            if (err || !file) {
                send(res, 404, TYPES['.html'], 'not found');
                return;
            }
            send(res, 200, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', data);
        });
    });
}

if (require.main === module) {
    const port = Number(process.env.PORT) || 5174;
    createServer().listen(port, '127.0.0.1', () => {
        console.log(`Aventurine Prism (web) on http://127.0.0.1:${port}/`);
    });
}

module.exports = { createServer };

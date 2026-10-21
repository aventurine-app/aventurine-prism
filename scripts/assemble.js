'use strict';

// ─── assemble.js ────────────────────────────────────────────────────────────
// Builds an HTML page: a file from pages/ (the app's pages/index.html, or one of
// the sign-in pages in pages/auth/) with each <!-- @include name --> marker
// replaced by pages/partials/name.html. The result is written to a file by
// build.js or sent by dev-server.js.
//
// The app version is written into the page as <meta name="prism-version"> so
// Preferences → About can show it.

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(APP_ROOT, 'pages');
const PARTIALS_DIR = path.join(PAGES_DIR, 'partials');
const STATIC_DIR = path.join(APP_ROOT, 'static');

const AUTH_DIR = path.join(PAGES_DIR, 'auth');

const INCLUDE_RE = /<!--\s*@include\s+([\w-]+)\s*-->/g;

/** The app version, from package.json. */
function readVersion() {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
    return String(pkg.version);
}

const escapeAttr = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The finished page as a string. A missing partial throws, so a bad build fails loudly. */
function assemblePage({ page = 'index.html', version = readVersion() } = {}) {
    const source = fs.readFileSync(path.join(PAGES_DIR, page), 'utf8');
    const html = source.replace(
        INCLUDE_RE,
        (_, name) => fs.readFileSync(path.join(PARTIALS_DIR, `${name}.html`), 'utf8'),
    );
    return html.replace('</head>', `    <meta name="prism-version" content="${escapeAttr(version)}">\n</head>`);
}

/** The names of the sign-in pages (login, confirm, inactive), from pages/auth/. */
function authPageNames() {
    return fs.readdirSync(AUTH_DIR).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -'.html'.length)).sort();
}

module.exports = { assemblePage, authPageNames, readVersion, APP_ROOT, STATIC_DIR };

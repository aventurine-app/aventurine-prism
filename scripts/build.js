'use strict';

// ─── build.js ───────────────────────────────────────────────────────────────
// Writes the deployable app to dist/:
//
//   index.html   the app's page (assemble.js)
//   auth/        the sign-in pages: login.html, confirm.html, inactive.html
//   static/      the app's CSS, JS, fonts and icons, as they are
//
// There is no bundling or minifying: the app is plain scripts served as
// written. Run it with `npm run build`.

const fs = require('fs');
const path = require('path');
const { assemblePage, authPageNames, readVersion, APP_ROOT, STATIC_DIR } = require('./assemble');

const DIST_DIR = path.join(APP_ROOT, 'dist');

// Not referenced by the app (icons are inlined from core/icon-data.js).
const SKIPPED = new Set([path.join('icons', 'Phosphor')]);

function build({ outDir = DIST_DIR } = {}) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'index.html'), assemblePage());
    fs.mkdirSync(path.join(outDir, 'auth'));
    for (const name of authPageNames()) {
        fs.writeFileSync(path.join(outDir, 'auth', `${name}.html`), assemblePage({ page: `auth/${name}.html` }));
    }
    fs.cpSync(STATIC_DIR, path.join(outDir, 'static'), {
        recursive: true,
        filter: (src) => !SKIPPED.has(path.relative(STATIC_DIR, src)),
    });
}

function sizeOf(dir) {
    let files = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue;
        files += 1;
        bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
    }
    return { files, bytes };
}

if (require.main === module) {
    build();
    const { files, bytes } = sizeOf(DIST_DIR);
    console.log(`Built Aventurine Planner ${readVersion()} to ${DIST_DIR}: ${files} files, ${(bytes / 1024).toFixed(0)} KB`);
}

module.exports = { build, DIST_DIR };

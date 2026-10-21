'use strict';

// Packaging inputs that nothing derives at build time: the installer icons are
// rendered by hand (npm run icons) and committed, so a logo change has to be
// followed by a render.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { sourceHash, BUILD_DIR, STAMP_FILE } = require('../scripts/make-icons');

test('the installer icons were rendered from the current logo', () => {
    const stamp = fs.readFileSync(path.join(BUILD_DIR, STAMP_FILE), 'utf8').trim();
    assert.equal(stamp, sourceHash(), 'static/icons/logo/logo.svg changed: run `npm run icons` and commit electron/build/');
});

'use strict';

// The assembled page and the built folder: nothing the page asks for is missing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { assemblePage, authPageNames, STATIC_DIR } = require('../scripts/assemble');
const { build } = require('../scripts/build');

const page = assemblePage({ version: '9.9.9' });

test('every include marker is replaced and the version is written into the page', () => {
    assert.ok(!/@include/.test(page));
    assert.ok(page.includes('<meta name="prism-version" content="9.9.9">'));
    assert.ok(page.includes('Content-Security-Policy'));
});

test('a version cannot break out of the meta tag', () => {
    const html = assemblePage({ version: '"><script>x</script>' });
    assert.ok(!html.includes('<script>x</script>'));
});

test('every /static file the page names exists', () => {
    const refs = [...page.matchAll(/(?:src|href)="(\/static\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 20);
    for (const ref of refs) {
        assert.ok(fs.existsSync(path.join(STATIC_DIR, ref.slice('/static/'.length))), `${ref} is missing`);
    }
});

test('the browser backend loads after the plan rules it uses and before the app that calls it', () => {
    const scripts = [...page.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    const at = (name) => scripts.indexOf(`/static/js/${name}`);
    for (const dep of ['sim/plan.js', 'web/api-error.js', 'web/plan-files.js', 'web/backend.js', 'web/file-dialogs.js']) {
        assert.ok(at(dep) >= 0, `${dep} is not loaded`);
    }
    assert.ok(at('sim/plan.js') < at('web/workspace.js'));
    assert.ok(at('web/api-error.js') < at('web/plan-files.js'));
    assert.ok(at('web/plan-files.js') < at('web/backend.js'));
    assert.ok(at('web/boot.js') > at('web/file-dialogs.js'));
    assert.ok(at('web/boot.js') < at('app/main.js'));
});

test('the page runs no inline script, as its CSP requires', () => {
    assert.ok([...page.matchAll(/<script\b[^>]*>/g)].every((m) => /\bsrc="/.test(m[0])));
});

test('a build holds the page and the app files, without the unused icon set', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-web-'));
    try {
        build({ outDir: out });
        assert.ok(fs.existsSync(path.join(out, 'index.html')));
        assert.ok(fs.existsSync(path.join(out, 'static', 'js', 'web', 'boot.js')));
        assert.ok(fs.existsSync(path.join(out, 'static', 'css', 'style.css')));
        assert.ok(!fs.existsSync(path.join(out, 'static', 'icons', 'Phosphor')));
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
});

test('the sign-in pages are built, and need only files the worker serves to anyone', async () => {
    const { isPublicAsset } = await import('../worker/src/index.js');
    const names = authPageNames();
    assert.deepEqual(names, ['confirm', 'inactive', 'login']);
    for (const name of names) {
        const html = assemblePage({ page: `auth/${name}.html`, version: '9.9.9' });
        assert.ok(!/@include/.test(html), name);
        assert.ok([...html.matchAll(/<script\b[^>]*>/g)].every((m) => /\bsrc="/.test(m[0])), `${name} has an inline script`);
        const refs = [...html.matchAll(/(?:src|href)="(\/static\/[^"]+)"/g)].map((m) => m[1]);
        assert.ok(refs.length > 5, name);
        for (const ref of refs) {
            assert.ok(fs.existsSync(path.join(STATIC_DIR, ref.slice('/static/'.length))), `${name}: ${ref} is missing`);
            assert.ok(isPublicAsset(ref), `${name} loads ${ref}, which the worker would keep behind sign-in`);
        }
    }
});

test('no file the worker serves to anyone holds app code', () => {
    const publicJs = fs.readdirSync(path.join(STATIC_DIR, 'js', 'auth'));
    assert.deepEqual(publicJs.sort(), ['common.js', 'confirm.js', 'dot-wave.js', 'inactive.js', 'login.js']);
    for (const f of publicJs) {
        const code = fs.readFileSync(path.join(STATIC_DIR, 'js', 'auth', f), 'utf8');
        assert.ok(!/CitrinePlan|CitrineEngine|Store\.|citrineApi/.test(code), `${f} reaches into the app`);
    }
});

test('a build holds the sign-in pages', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-web-'));
    try {
        build({ outDir: out });
        for (const name of ['login', 'confirm', 'inactive']) assert.ok(fs.existsSync(path.join(out, 'auth', `${name}.html`)), name);
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
});

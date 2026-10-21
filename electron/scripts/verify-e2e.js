'use strict';

// End-to-end verification: boots the REAL app entry (main.js) against an
// isolated profile, waits for the window, then asserts from INSIDE the renderer:
// the page and its security posture, the blank first plan and the example it
// loads, the canvas and library, an edit → undo → redo round trip, a save that
// survives a fresh read through IPC, and the Updates section of About (with
// Automatic Updates off, so the run stays off the network). Exits 0 on PASS.
//
//   npm run verify   (close `npm start` first: one instance per profile)

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'citrine-e2e-'));
// Automatic Updates off, so the run never reaches the network (a dev run
// would otherwise ask GitHub for the latest release ten seconds in).
fs.writeFileSync(path.join(tmp, 'update-preferences.json'), JSON.stringify({ autoUpdate: false }));
const { app, BrowserWindow } = require('electron');

require('../main.js');
// After the require: main.js points userData at the dev profile when it
// loads, and the backend reads userData only at whenReady, so this is what
// isolates the run.
app.setPath('userData', tmp);

if (!app.hasSingleInstanceLock()) {
    console.error('FAIL  another Aventurine Prism instance holds the single-instance lock. '
        + 'Close `npm start` and run this again.');
    process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWindow() {
    const t0 = Date.now();
    for (;;) {
        const wins = BrowserWindow.getAllWindows();
        if (wins.length && !wins[0].webContents.isLoading()) return wins[0];
        if (Date.now() - t0 > 20000) throw new Error('window never finished loading');
        await sleep(200);
    }
}

app.whenReady().then(async () => {
    let failed = false;
    const check = (label, cond) => {
        console.log(`${cond ? 'ok ' : 'FAIL'}  ${label}`);
        if (!cond) failed = true;
    };
    const errors = [];
    try {
        const win = await waitForWindow();
        win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
        const js = (code) => win.webContents.executeJavaScript(code, true);
        // Wait for boot to finish (the first plan simulated and drawn).
        for (let i = 0; i < 50 && !(await js('!!(window.Store && Store.state.results)')); i++) await sleep(100);
        await sleep(300);

        check('renderer is on the app origin', win.webContents.getURL() === 'app://citrine/');
        check('window title names the plan', (await js('document.title')) === 'Untitled plan | Aventurine Prism');
        check('document parsed as UTF-8', (await js('document.characterSet')) === 'UTF-8');
        check('no inline scripts', await js('[...document.scripts].every((s) => s.src)'));
        check('CSP meta present', await js(`!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')`));
        check('window.open is denied', await js('window.open("https://example.com") === null'));
        check('no Node in the renderer', await js('typeof require === "undefined" && typeof process === "undefined"'));
        check('a fresh install opens a blank plan on the empty-plan card', await js(
            'Store.state.plan.nodes.length === 0 && !document.querySelector(".canvas-empty").hidden'));

        // The example, from the empty plan's card.
        await js('document.querySelector(\'.canvas-empty [data-act="example"]\').click()');
        for (let i = 0; i < 20 && (await js('Store.state.results.totals.endNetWorth')) <= 0; i++) await sleep(50);
        await sleep(100);
        const start = JSON.parse(await js(`JSON.stringify({
            nodes: Store.state.plan.nodes.length, links: Store.state.plan.links.length,
            warnings: Store.state.results.warnings.map((w) => w.code), months: Store.state.results.months,
            worth: Store.state.results.totals.endNetWorth })`));
        check('the example has 6 modules and 5 links', start.nodes === 6 && start.links === 5);
        check('the example simulates 60 months cleanly', start.months === 60 && start.warnings.length === 0 && start.worth > 0);
        if (start.warnings.length) console.log('      warnings:', start.warnings.join(', '));

        check('canvas drew every module', (await js('document.querySelectorAll("#nodes .node").length')) === 6);
        check('canvas drew every link label', (await js('document.querySelectorAll("#labels .link-label").length')) === 5);
        check('a credit card draws one output port', await js(`(() => {
            const card = Store.state.plan.nodes.find((n) => n.type === 'credit-card');
            return document.querySelectorAll('#nodes .node[data-id="' + card.id + '"] .node-port--out').length === 1;
        })()`));
        check('a card\'s output port sits level with its input port, where links meet it', await js(`(() => {
            const card = [...document.querySelectorAll('#nodes .node')]
                .find((n) => !n.querySelector('.node-port--in').hidden && n.querySelector('.node-port--out'));
            const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
            return Math.abs(mid(card.querySelector('.node-port--in')) - mid(card.querySelector('.node-port--out'))) < 0.5;
        })()`));
        check('every link and port is drawn in a colour', await js(`(() => {
            const paint = (el, prop) => getComputedStyle(el)[prop];
            const links = [...document.querySelectorAll('#links .link-path')].every((p) => paint(p, 'stroke') !== 'none');
            const ports = [...document.querySelectorAll('#nodes .node-port--out')].every((p) => paint(p, 'backgroundColor') !== 'rgba(0, 0, 0, 0)');
            return links && ports;
        })()`));
        check('library shelves every preset', await js('document.querySelectorAll(".lib-tile").length === CitrineCatalog.PRESETS.length'));
        check('outlook drew the net worth chart', await js('!!document.querySelector("#outlook .chart-band")'));

        // The outlook's header row fits its panel, at the default size and at
        // the narrowest window, rather than running into the inspector.
        const headFits = [];
        for (const w of [1440, 1024]) {
            win.setSize(w, 900);
            await sleep(200);
            headFits.push(await js('(() => { const h = document.querySelector(".outlook-head"); return h.scrollWidth <= h.clientWidth; })()'));
        }
        win.setSize(1440, 900);
        await sleep(200);
        check('the outlook header fits its panel at the default and the narrowest window', headFits.every(Boolean));

        // Edit, undo, redo.
        await js(`(() => {
            const s = Store.state.plan.nodes[0];
            const n = Store.addNode('expense', s.x, s.y + 400);
            Store.connect(s.id, n.id);
        })()`);
        await sleep(100);
        check('a new module and link render', (await js('document.querySelectorAll("#nodes .node").length')) === 7
            && (await js('Store.state.plan.links.length')) === 6);
        check('the new link reads as a sentence', /Send .*Expense/.test(await js('document.querySelector("[data-sentence]")?.textContent || ""')));
        await js('Store.undo()');
        check('undo removes the link', (await js('Store.state.plan.links.length')) === 5);
        await js('Store.redo()');
        check('redo restores it', (await js('Store.state.plan.links.length')) === 6);

        // Box-select every module, then drag one card: the whole group moves, in one undo step.
        await js('Canvas.fit()');
        await sleep(100);
        await js(`(() => {
            const stage = document.getElementById('stage');
            const r = stage.getBoundingClientRect();
            const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
                bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: x, clientY: y }));
            fire(stage, 'pointerdown', r.left + 2, r.top + 2);
            fire(stage, 'pointermove', r.right - 2, r.bottom - 2);
            fire(stage, 'pointerup', r.right - 2, r.bottom - 2);
        })()`);
        check('box-select marks every module', (await js('document.querySelectorAll("#nodes .node.is-selected").length')) === 7);
        const before = await js('JSON.stringify(Store.state.plan.nodes.map((n) => [n.x, n.y]))');
        const undoDepth = await js('Store.canUndo()');
        await js(`(() => {
            const card = document.querySelector('#nodes .node').getBoundingClientRect();
            const el = document.querySelector('#nodes .node');
            const x = card.left + 40; const y = card.top + 40;
            const fire = (type, dx) => el.dispatchEvent(new PointerEvent(type, {
                bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: x + dx, clientY: y }));
            fire('pointerdown', 0); fire('pointermove', 60); fire('pointermove', 120); fire('pointerup', 120);
        })()`);
        const moved = JSON.parse(await js('JSON.stringify(Store.state.plan.nodes.map((n) => [n.x, n.y]))'));
        const was = JSON.parse(before);
        const shifts = new Set(moved.map((m, i) => `${m[0] - was[i][0]},${m[1] - was[i][1]}`));
        check('dragging one selected card moves the whole group by the same distance', shifts.size === 1 && !shifts.has('0,0'));
        check('the group stays selected after the drag', (await js('document.querySelectorAll("#nodes .node.is-selected").length')) === 7);
        await js('Store.undo()');
        check('one undo puts the group back', (await js('JSON.stringify(Store.state.plan.nodes.map((n) => [n.x, n.y]))')) === before && undoDepth);
        await js('document.getElementById("stage").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
        check('Escape clears the group', (await js('document.querySelectorAll("#nodes .node.is-selected").length')) === 0);

        // Persistence through the backend.
        check('save succeeds', await js('Store.flush()'));
        const saved = JSON.parse(await js(`api('GET', '/api/plans/' + Store.state.activeId).then((r) => JSON.stringify(r.body.plan))`));
        check('the saved plan holds the edit', saved.nodes.length === 7 && saved.links.length === 6);

        // A card pays for spending: a link out of it is a purchase.
        const spend = JSON.parse(await js(`(() => {
            const card = Store.state.plan.nodes.find((n) => n.type === 'credit-card');
            const link = Store.connect(card.id, Store.addNode('expense', 2400, 400).id);
            return JSON.stringify({ basis: link && link.basis, labels: document.querySelectorAll('#labels .link-label').length });
        })()`));
        check('a link from a card to spending is a purchase, drawn at once', spend.basis === 'charges' && spend.labels === 7);

        // Removing modules (as deleting a box-selected group does) takes their
        // links along and points a card's cash back away from them.
        const removal = JSON.parse(await js(`(() => {
            const plan = Store.state.plan;
            const card = plan.nodes.find((n) => n.type === 'credit-card');
            const into = card.params.cashBackTo;
            const spending = plan.nodes.find((n) => n.type === 'expense');
            const before = plan.nodes.length;
            Store.removeNodes([into, spending.id]);
            const now = Store.state.plan;
            const result = {
                removed: before - now.nodes.length,
                cleared: card.params.cashBackTo === null,
                dangling: now.links.some((l) => [into, spending.id].includes(l.from) || [into, spending.id].includes(l.to)),
            };
            Store.undo();
            result.restored = Store.state.plan.nodes.find((n) => n.type === 'credit-card').params.cashBackTo === into;
            return JSON.stringify(result);
        })()`));
        check('removing modules takes their links and clears cash back into them', removal.removed === 2 && removal.cleared && !removal.dangling);
        check('one undo brings them back, cash back included', removal.restored);

        // At the module limit a duplicate is refused, rather than making a
        // plan the backend would refuse to save.
        const limit = JSON.parse(await js(`(() => {
            const P = CitrinePlan;
            const before = Store.state.plan.nodes.length;
            Store.edit((plan) => {
                for (let i = plan.nodes.length; i < P.LIMITS.nodes; i++) {
                    plan.nodes.push(P.createNode(plan, 'expense', 4000 + (i % 20) * 240, 2000 + Math.floor(i / 20) * 140));
                }
            });
            const full = Store.state.plan.nodes.length;
            const copy = Store.duplicateNode(Store.state.plan.nodes[0].id);
            const after = Store.state.plan.nodes.length;
            Store.undo();
            return JSON.stringify({ full, copied: !!copy, after, restored: Store.state.plan.nodes.length === before });
        })()`));
        check('duplicating at the module limit is refused', limit.full === 400 && !limit.copied && limit.after === 400);
        check('undo takes the plan back below the limit', limit.restored);
        check('the plan saves afterwards', await js('Store.flush()'));

        // Scrubbing the chart moves the canvas to that month.
        await js(`(() => {
            const hit = document.querySelector('.chart-hit');
            const r = hit.getBoundingClientRect();
            hit.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width / 2, clientY: r.top + 10, bubbles: true }));
        })()`);
        await sleep(100);
        check('chart hover scrubs the plan', (await js('Store.state.scrub')) !== null
            && !(await js('document.querySelector(".island--time").hidden')));

        // The library collapses to a rail; pressing an icon opens its modules.
        await js('Library.toggleRail()');
        await sleep(350);
        check('collapsing the library leaves a rail of category icons', await js(`(() => {
            const lib = document.getElementById('library');
            const w = lib.getBoundingClientRect().width;
            return lib.classList.contains('is-rail') && w > 40 && w < 80
                && document.querySelectorAll('.rail-cat').length === CitrineCatalog.CATEGORIES.length;
        })()`));
        await js('document.querySelector(\'.rail-cat[data-cat="debt"]\').click()');
        await sleep(100);
        check('pressing an icon opens that category', await js(`document.querySelectorAll('.lib-flyout .lib-flyout-item').length
            === CitrineCatalog.PRESETS.filter((p) => p.cat === 'debt').length`));
        const nodesBefore = await js('Store.state.plan.nodes.length');
        await js('document.querySelector(".lib-flyout .lib-flyout-item").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))');
        await sleep(150);
        check('double-clicking a module in the panel adds it and closes the panel', (await js('Store.state.plan.nodes.length')) === nodesBefore + 1
            && await js('!document.querySelector(".lib-flyout")'));
        await js('Library.toggleRail()');
        await sleep(350);
        check('expanding brings the full library back', await js('!document.getElementById("library").classList.contains("is-rail") && document.getElementById("library").getBoundingClientRect().width > 150'));

        // Software updates, as far as they go without the network: the
        // profile was seeded with Automatic Updates off.
        await js('Settings.open("about")');
        await sleep(150);
        const updates = JSON.parse(await js(`JSON.stringify({
            shown: !document.querySelector('[data-updates-section]').hidden,
            off: document.querySelector('[data-update-auto] [data-value="off"]').getAttribute('aria-pressed') === 'true',
            status: document.querySelector('[data-update-status]').textContent,
            action: [...document.querySelectorAll('[data-update-action]')].filter((b) => !b.hidden).map((b) => b.dataset.updateAction).join(),
        })`));
        check('About shows the Updates section', updates.shown);
        check('Automatic Updates reads back the saved Off', updates.off);
        check('the update status names the installed version', /^You have version \d+\.\d+\.\d+\.$/.test(updates.status));
        check('Check for Updates is the one action offered', updates.action === 'check');
        const updateState = JSON.parse(await js('electronUpdater.getState().then(JSON.stringify)'));
        check('a dev run only notifies, and has made no check', updateState.mode === 'notify'
            && updateState.autoUpdate === false && updateState.state === 'idle');
        await js('UI.closeModal(document.getElementById("prefs"))');

        check('no console errors', errors.length === 0);
        if (errors.length) console.log(errors.join('\n'));
    } catch (e) {
        console.error('FAIL  exception:', e);
        failed = true;
    }
    console.log(failed ? 'E2E: FAIL' : 'E2E: PASS');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    app.exit(failed ? 1 : 0);
});

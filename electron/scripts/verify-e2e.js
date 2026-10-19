'use strict';

// End-to-end verification: boots the REAL app entry (main.js) against an
// isolated profile, waits for the window, then asserts from INSIDE the renderer:
// the page and its security posture, the starter plan and its simulation, the
// canvas and library, an edit → undo → redo round trip, a save that survives a
// fresh read through IPC, and the Updates section of About (with Automatic
// Updates off, so the run stays off the network). Exits 0 on PASS.
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
        // Wait for boot to finish (the starter plan simulated and drawn).
        for (let i = 0; i < 50 && !(await js('!!(window.Store && Store.state.results)')); i++) await sleep(100);
        await sleep(300);

        check('renderer is on the app origin', win.webContents.getURL() === 'app://citrine/');
        check('window title names the plan', (await js('document.title')) === 'Five-year outlook | Aventurine Prism');
        check('document parsed as UTF-8', (await js('document.characterSet')) === 'UTF-8');
        check('no inline scripts', await js('[...document.scripts].every((s) => s.src)'));
        check('CSP meta present', await js(`!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')`));
        check('window.open is denied', await js('window.open("https://example.com") === null'));
        check('no Node in the renderer', await js('typeof require === "undefined" && typeof process === "undefined"'));

        const start = JSON.parse(await js(`JSON.stringify({
            nodes: Store.state.plan.nodes.length, links: Store.state.plan.links.length,
            warnings: Store.state.results.warnings.length, months: Store.state.results.months,
            worth: Store.state.results.totals.endNetWorth })`));
        check('starter plan has 6 modules and 7 links', start.nodes === 6 && start.links === 7);
        check('starter plan simulates 60 months cleanly', start.months === 60 && start.warnings === 0 && start.worth > 0);

        check('canvas drew every module', (await js('document.querySelectorAll("#nodes .node").length')) === 6);
        check('canvas drew every link label', (await js('document.querySelectorAll("#labels .link-label").length')) === 7);
        check('a credit card draws three output ports', await js(`(() => {
            const card = Store.state.plan.nodes.find((n) => n.type === 'credit-card');
            const ports = [...document.querySelectorAll('#nodes .node[data-id="' + card.id + '"] .node-port--out')];
            return ports.map((p) => p.dataset.basis).join() === 'inflow,charges,cashback';
        })()`));
        check('every link and port is drawn in a colour', await js(`(() => {
            const paint = (el, prop) => getComputedStyle(el)[prop];
            const links = [...document.querySelectorAll('#links .link-path')].every((p) => paint(p, 'stroke') !== 'none');
            const ports = [...document.querySelectorAll('#nodes .node-port--out')].every((p) => paint(p, 'backgroundColor') !== 'rgba(0, 0, 0, 0)');
            return links && ports;
        })()`));
        check('library shelves every preset', await js('document.querySelectorAll(".lib-tile").length === CitrineCatalog.PRESETS.length'));
        check('outlook drew the net worth chart', await js('!!document.querySelector("#outlook .chart-band")'));

        // Edit, undo, redo.
        await js(`(() => {
            const s = Store.state.plan.nodes[0];
            const n = Store.addNode('rent', s.x, s.y + 400);
            Store.connect(s.id, n.id);
        })()`);
        await sleep(100);
        check('a new module and link render', (await js('document.querySelectorAll("#nodes .node").length')) === 7
            && (await js('Store.state.plan.links.length')) === 8);
        check('the new link reads as a sentence', /Send .*Rent/.test(await js('document.querySelector("[data-sentence]")?.textContent || ""')));
        await js('Store.undo()');
        check('undo removes the link', (await js('Store.state.plan.links.length')) === 7);
        await js('Store.redo()');
        check('redo restores it', (await js('Store.state.plan.links.length')) === 8);

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
        check('the saved plan holds the edit', saved.nodes.length === 7 && saved.links.length === 8);

        // A loan docks under a property, and the strips hang below the stack.
        const dock = JSON.parse(await js(`(() => {
            const home = Store.addNode('home', 2400, 0);
            const loan = Store.addLoan(home.id, 'mortgage');
            return JSON.stringify({ home: home.id, loan: loan.id, hx: home.x, hy: home.y, lx: loan.x, ly: loan.y });
        })()`));
        await sleep(150);
        check('a mortgage docks directly under the home', dock.lx === dock.hx && dock.ly === dock.hy + 112);
        check('the home draws a "+ debt" strip below its loan', await js(`(() => {
            const f = document.querySelector('.node[data-id="${dock.home}"] .node-foot');
            return !!f && !f.hidden && f.style.top === '184px' && !!f.querySelector('[data-foot="add"]');
        })()`));
        check('a loan nobody pays shows an empty payer dot', await js(`document.querySelector('.node[data-id="${dock.loan}"]').classList.contains('is-unpaid')`));
        check('the home shows equity', (await js(`document.querySelector('.node[data-id="${dock.home}"] .node-unit').textContent`)) === 'equity');
        await js(`Store.beginGesture(); Store.gestureMove((pl) => { pl.nodes.find((n) => n.id === '${dock.home}').x += 96; }); Store.endGesture();`);
        check('moving the home moves its loan with it', (await js(`Store.node('${dock.loan}').x - Store.node('${dock.home}').x`)) === 0);
        await js(`Store.undockLoan('${dock.loan}')`);
        check('detaching sets the loan beside the home', (await js(`Store.node('${dock.loan}').dock === undefined && Store.node('${dock.loan}').x > Store.node('${dock.home}').x`)));
        await js(`Store.dockLoan('${dock.loan}', '${dock.home}')`);
        check('a loan can be attached again', (await js(`Store.node('${dock.loan}').dock`)) === dock.home);

        // The selection ring wraps the whole module: card, docked loan and strip.
        await js(`Store.select({ kind: 'node', id: '${dock.home}' })`);
        await sleep(150);
        check('the selection ring wraps a property with its loan and strip', await js(`(() => {
            const el = document.querySelector('.node[data-id="${dock.home}"]');
            return Math.round(parseFloat(getComputedStyle(el, '::after').height)) === 112 + 72 + 32 + 8;
        })()`));
        await js(`Store.select({ kind: 'node', id: '${dock.loan}' })`);
        await sleep(150);
        check('a selected docked loan has no ring of its own', await js(`(() => {
            const el = document.querySelector('.node[data-id="${dock.loan}"]');
            return getComputedStyle(el, '::after').display === 'none';
        })()`));

        // Dropping a link on a property pays the loan docked under it.
        await js('Canvas.fit()');
        await sleep(250);
        check('dropping a link on a home pays its docked loan', await js(`(() => {
            const stage = document.getElementById('stage');
            const salary = Store.state.plan.nodes.find((n) => n.type === 'salary');
            const port = document.querySelector('.node[data-id="' + salary.id + '"] .node-port--out');
            const home = document.querySelector('.node[data-id="${dock.home}"]').getBoundingClientRect();
            const p = port.getBoundingClientRect();
            const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
                bubbles: true, cancelable: true, pointerId: 11, button: 0, clientX: x, clientY: y }));
            fire(port, 'pointerdown', p.left + p.width / 2, p.top + p.height / 2);
            fire(stage, 'pointermove', home.left + home.width / 2, home.top + 30);
            fire(stage, 'pointerup', home.left + home.width / 2, home.top + 30);
            const links = Store.state.plan.links;
            return links.some((l) => l.from === salary.id && l.to === '${dock.loan}')
                && !links.some((l) => l.from === salary.id && l.to === '${dock.home}');
        })()`));
        await sleep(100);
        check('a paid loan loses its empty payer dot', await js(`!document.querySelector('.node[data-id="${dock.loan}"]').classList.contains('is-unpaid')`));

        // A spending module picks the card that pays for it.
        const spend = await js(`(() => {
            const sp = Store.state.plan.nodes.find((n) => n.type === 'rent') || Store.addNode('rent', 2400, 400);
            const card = Store.payWithCard(sp.id, 'new');
            return JSON.stringify({ sp: sp.id, card: card.id });
        })()`).then(JSON.parse);
        await sleep(150);
        check('choosing a new card links it to the spending by Purchases', await js(`Store.state.plan.links.some((l) => l.from === '${spend.card}' && l.to === '${spend.sp}' && l.basis === 'charges')`));
        check('the spending shows the card in its slot', await js(`!!document.querySelector('.node[data-id="${spend.sp}"] .node-slot.is-on')`));
        check('the card lists what it pays for', await js(`!!document.querySelector('.node[data-id="${spend.card}"] .node-tray .o-chip')`));
        await js(`Store.payWithCard('${spend.sp}', null)`);
        check('taking spending off its card removes the link', await js(`!Store.state.plan.links.some((l) => l.to === '${spend.sp}' && l.basis === 'charges')`));

        // Scrubbing the chart moves the canvas to that month.
        await js(`(() => {
            const hit = document.querySelector('.chart-hit');
            const r = hit.getBoundingClientRect();
            hit.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width / 2, clientY: r.top + 10, bubbles: true }));
        })()`);
        await sleep(100);
        check('chart hover scrubs the plan', (await js('Store.state.scrub')) !== null
            && !(await js('document.querySelector(".island--time").hidden')));

        // The library collapses to a rail; holding an icon opens its modules.
        const press = (type) => js(`(() => {
            const b = document.querySelector('.rail-cat[data-cat="debt"]');
            b.dispatchEvent(new PointerEvent('${type}', { bubbles: true, pointerId: 9, button: 0 }));
        })()`);
        await js('Library.toggleRail()');
        await sleep(350);
        check('collapsing the library leaves a rail of category icons', await js(`(() => {
            const lib = document.getElementById('library');
            const w = lib.getBoundingClientRect().width;
            return lib.classList.contains('is-rail') && w > 40 && w < 80
                && document.querySelectorAll('.rail-cat').length === CitrineCatalog.CATEGORIES.length;
        })()`));
        await press('pointerdown');
        await sleep(120);
        await press('pointerup');
        check('a short press opens nothing and shows a hint', await js('!document.querySelector(".lib-flyout") && !!document.querySelector(".rail-hint")'));
        await sleep(1500);
        await press('pointerdown');
        await sleep(550);
        await press('pointerup');
        check('holding an icon opens that category', await js(`document.querySelectorAll('.lib-flyout .lib-flyout-item').length
            === CitrineCatalog.PRESETS.filter((p) => p.cat === 'debt').length`));
        const nodesBefore = await js('Store.state.plan.nodes.length');
        await js('document.querySelector(".lib-flyout .lib-flyout-item").click()');
        await sleep(150);
        check('pressing a module in the panel adds it and closes the panel', (await js('Store.state.plan.nodes.length')) === nodesBefore + 1
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

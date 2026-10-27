'use strict';

// End-to-end check of the web app in a real Chromium. Electron is used only as
// the browser: the dev server serves the app, a window loads it with NO preload
// bridge (so it behaves as it will in a user's browser), and every assertion
// runs from inside the page. Covers storage in IndexedDB, a reload, a save made
// as the page closes, the one-editing-tab rule, export and import, and the
// Storage preferences, and the navigation's workspaces with the goals they
// share. Exits 0 on PASS.
//
//   npm run verify

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('./dev-server');

// A throwaway profile, so IndexedDB starts empty and the run leaves nothing behind.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-web-verify-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let failed = false;

function check(label, ok) {
    console.log(`${ok ? 'ok ' : 'FAIL'}  ${label}`);
    if (!ok) failed = true;
}

function openWindow(url) {
    const win = new BrowserWindow({
        show: false,
        width: 1440,
        height: 900,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.webContents.on('console-message', (e) => {
        if (e.level === 'error') errors.push(e.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    return win.loadURL(url).then(() => ({ win, js }));
}

async function until(js, expression, ms = 8000) {
    for (let t = 0; t < ms; t += 100) {
        if (await js(expression)) return true;
        await sleep(100);
    }
    return false;
}

const appReady = '!!(window.Store && Store.state.results)';

async function main(url) {
    const first = await openWindow(url);
    const { js } = first;
    check('the app boots', await until(js, appReady));

    check('the data bridge is installed', await js('!!window.citrineApi'));
    check('a first visit opens one blank plan', await js('Store.state.tabs.length === 1 && Store.state.plan.nodes.length === 0'));

    // Build something, save it, and look inside IndexedDB itself.
    await js('document.querySelector(\'.canvas-empty [data-act="example"]\').click()');
    check('the example loads', await until(js, 'Store.state.plan.nodes.length === 6'));
    check('Ctrl+S style flush saves', await js('Store.flush()'));
    const stored = JSON.parse(await js(`new Promise((resolve, reject) => {
        const open = indexedDB.open('aventurine-prism');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const tx = open.result.transaction(['plans', 'meta']);
            const plans = tx.objectStore('plans').getAll();
            const tabs = tx.objectStore('meta').get('tabs');
            tx.oncomplete = () => resolve(JSON.stringify({
                nodes: plans.result.map((p) => p.nodes.length), tabs: tabs.result }));
        };
    })`));
    check('IndexedDB holds the plan with its six modules', stored.nodes.length === 1 && stored.nodes[0] === 6);
    check('and the tab order', stored.tabs && stored.tabs.order.length === 1 && stored.tabs.active === stored.tabs.order[0]);

    // A reload brings it all back.
    await first.win.webContents.reloadIgnoringCache();
    check('after a reload the plan is back', await until(js, appReady + ' && Store.state.plan.nodes.length === 6'));

    // An edit made just before the page closes must still be saved.
    await js('Store.renamePlan(Store.state.activeId, "Edited at the last moment")');
    await first.win.webContents.reloadIgnoringCache();
    await until(js, appReady);
    check('an edit made just before a reload was saved',
        await js('Store.state.plan.name === "Edited at the last moment"'));

    // Export goes through the browser's save dialog; hand it a fake one.
    await js(`window.showSaveFilePicker = async (o) => ({ createWritable: async () => ({
        write: async (t) => { window.__saved = { name: o.suggestedName, text: t }; }, close: async () => {} }) });
        true;`);
    await js('Store.exportPlan(Store.state.activeId)');
    const exported = JSON.parse(await js('JSON.stringify(window.__saved || null)'));
    check('export saves a named plan file', exported && exported.name === 'Edited at the last moment.json');
    const file = exported && JSON.parse(exported.text);
    check('that file is the plan, in the readable format', file && file.format === 'citrine-plan' && file.plan.nodes.length === 6);

    // Import reads a file the user picked; hand it that text. It is offered by
    // Add plan, under the list of plans (its only place), so go through that menu.
    await js(`PrismWeb.fileDialogs.open = async () => ${JSON.stringify(exported && exported.text)}; true`);
    await js(`document.querySelector('.nav-add').click();
        [...document.querySelectorAll('.menu-pop .menu-item')].find((b) => b.textContent.trim() === 'Import plan…').click(); true`);
    check('import, from Add plan, adds the plan',
        await until(js, 'Store.state.tabs.length === 2 && Store.state.plan.nodes.length === 6'));
    check('with its own id', await js('new Set(Store.state.tabs).size === 2'));
    await js('Store.flush()');

    // The navigation: each workspace opens on its own, and goals are kept once,
    // for every plan, beside the plans in IndexedDB.
    const showsOnly = (cls) => `[...document.querySelectorAll('.workbench > section')]
        .every((s) => (getComputedStyle(s).display !== 'none') === s.classList.contains('${cls}'))`;
    for (const [go, cls] of [['goals', 'goals-board'], ['analyze', 'outlook'], ['compare', 'compare']]) {
        await js(`document.querySelector('.nav-item[data-go="${go}"]').click()`);
        check(`the navigation opens ${go}`, await until(js, showsOnly(cls)));
    }
    check('Compare lists every plan', await until(js, `document.querySelectorAll('.compare-table tbody tr').length === 2`));
    await js(`document.querySelector('.nav-item[data-go="goals"]').click(); document.querySelector('[data-preset="retire"]').click(); true`);
    await js('Store.flush()');
    const goals = JSON.parse(await js(`new Promise((resolve, reject) => {
        const open = indexedDB.open('aventurine-prism');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const req = open.result.transaction('meta').objectStore('meta').get('goals');
            req.onsuccess = () => resolve(JSON.stringify(req.result || []));
        };
    })`));
    check('a goal is stored once, for every plan, as its rule',
        goals.length === 1 && goals[0].metric === 'net-worth' && goals[0].unit === 'times' && goals[0].due === 'age');
    await js(`document.querySelector('.nav-plan').click()`);
    check('pressing a plan opens it in the builder', await until(js, showsOnly('builder') + ` && Store.state.workspace === 'plans'`));

    // Preferences → Storage speaks of the browser, not a file.
    await js('Settings.open("storage")');
    check('the Storage tab says whether the browser will keep the plans',
        await until(js, `document.querySelector('[data-persist-desc]').textContent !== 'Checking…'`));
    await js('Settings.open("about"); true');
    check('About shows the build version',
        await until(js, `document.querySelector('[data-app-version]').textContent === ${JSON.stringify(require('./assemble').readVersion())}`));
    await js('UI.closeModal && UI.closeModal(document.getElementById("prefs"))');

    // A second tab must wait for the first.
    const second = await openWindow(url);
    check('a second tab is told another tab is editing',
        await until(second.js, `!document.getElementById('lockscreen').hidden
            && document.querySelector('.lock-title').textContent.includes('another tab')`));
    check('and does not load the plans meanwhile', await second.js('!document.getElementById("app") || document.getElementById("app").hidden'));

    first.win.destroy();
    check('once the first tab closes, the second opens the plans',
        await until(second.js, appReady + ' && Store.state.tabs.length === 2', 10000));
    check('its waiting screen is gone', await second.js('document.getElementById("lockscreen").hidden'));
    check('it sees what the first tab saved',
        await second.js('Store.state.tabs.some((id) => Store.getPlan(id).name === "Edited at the last moment")'));

    second.win.destroy();
    const relevant = errors.filter((m) => !/Autofill|favicon/i.test(m));
    check('no console errors', relevant.length === 0);
    if (relevant.length) console.log(relevant.join('\n'));
}

app.whenReady().then(async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        await main(`http://127.0.0.1:${server.address().port}/`);
    } catch (e) {
        console.error('FAIL ', e);
        failed = true;
    }
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
    console.log(failed ? '\nFAILED' : '\nPASS');
    app.exit(failed ? 1 : 0);
});

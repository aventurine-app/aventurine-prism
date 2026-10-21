'use strict';

// ─── Electron shell for Aventurine Prism ─────────────────────────────────────────────
//
// Same architecture as Aventurine. The backend runs in THIS process
// (electron/backend/) and the renderer reaches it over one IPC channel
// ('api:request' → backend/routes.dispatch). There is no HTTP server, no
// socket and no port, so no other process on the machine can reach the data.
//
// The single page is static HTML from pages/, served over the custom app://
// scheme with its shared chrome spliced in from pages/partials/. The fixed
// origin (app://citrine) keeps localStorage (theme, number format) stable.
//
// The only network calls are software updates (updater.js), which ask GitHub
// for the latest version and stop entirely when the user turns Automatic
// Updates off. Nothing here opens a URL outside the app origin; the one way to
// the OS browser is updater.js's fixed download page.

const { app, BrowserWindow, Menu, ipcMain, dialog, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { initUpdater } = require('./updater');

const APP_HOST = 'citrine';
const APP_ORIGIN = `app://${APP_HOST}`;

// Repo layout: electron/ sits next to pages/ and static/.
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(PROJECT_ROOT, 'pages');
const STATIC_DIR = path.join(PROJECT_ROOT, 'static');
const PARTIALS_DIR = path.join(PAGES_DIR, 'partials');

const PAGE_ROUTES = { '/': 'index.html' };

// app:// must be registered as standard+secure BEFORE whenReady so the
// renderer treats it as a normal origin (localStorage, fetch).
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// No default File/Edit/View menu: the page draws its own title bar.
Menu.setApplicationMenu(null);

// `npm start` uses its own profile so it never shares a plans file (or the
// Chromium storage lock) with an installed build.
if (!app.isPackaged) {
    app.setPath('userData', path.join(app.getPath('appData'), 'citrine-dev'));
}

// ─── Single instance ────────────────────────────────────────────────────────
// One process per profile: a second window on the same plans file would be a
// second writer with its own copy of every plan.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });
}

let workspace = null;
let mainWindow = null;

// ─── Backend (in-process) ───────────────────────────────────────────────────

function plansFilePath() {
    const dataDir = process.env.CITRINE_DATA_DIR || path.join(app.getPath('userData'), 'data');
    process.env.CITRINE_DATA_DIR = dataDir;
    if (process.env.CITRINE_FILE_PATH) return process.env.CITRINE_FILE_PATH;
    const filePath = path.join(dataDir, 'plans.prism');
    migrateLegacyPlansFile(dataDir, filePath);
    return filePath;
}

/** v0.1.0 named the plans file plans.citrine. Move it (and its .bak) to the
 *  new name once, and only when nothing exists at the new name yet. */
function migrateLegacyPlansFile(dataDir, filePath) {
    const legacy = path.join(dataDir, 'plans.citrine');
    if (fs.existsSync(filePath) || !fs.existsSync(legacy)) return;
    fs.renameSync(legacy, filePath);
    if (fs.existsSync(`${legacy}.bak`) && !fs.existsSync(`${filePath}.bak`)) {
        fs.renameSync(`${legacy}.bak`, `${filePath}.bak`);
    }
}

/** File-name-safe version of a plan name for the export dialog. */
function safeFileName(name) {
    // eslint-disable-next-line no-control-regex
    return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 60) || 'plan';
}

function documentsDir() {
    try { return app.getPath('documents'); } catch { return app.getPath('home'); }
}

const PLAN_FILE_FILTERS = [
    { name: 'Aventurine Prism Plan', extensions: ['json'] },
    { name: 'All Files', extensions: ['*'] },
];
// Plans exported earlier are .prism or .citrine-plan: import offers all three.
const PLAN_IMPORT_FILTERS = [
    { name: 'Aventurine Prism Plan', extensions: ['json', 'prism', 'citrine-plan'] },
    { name: 'All Files', extensions: ['*'] },
];

// Native dialogs for export and import, handed to the backend as ctx.dialogs.
// The path comes from a dialog the sandboxed renderer cannot drive, which is
// why the backend never has to trust a path from the page.
const dialogs = {
    async chooseExportPath(planName) {
        const r = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Plan',
            defaultPath: path.join(documentsDir(), `${safeFileName(planName)}.json`),
            filters: PLAN_FILE_FILTERS,
        });
        return r.canceled ? null : r.filePath;
    },
    async chooseImportPath() {
        const r = await dialog.showOpenDialog(mainWindow, {
            title: 'Import Plan',
            properties: ['openFile'],
            filters: PLAN_IMPORT_FILTERS,
        });
        return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    },
};

/** Open the plans file. An unreadable file is never overwritten: the user
 *  either quits (and can restore it) or has it moved aside first. */
function startBackend() {
    const { createWorkspace } = require('./backend/workspace');
    const { dispatch } = require('./backend/routes');
    const filePath = plansFilePath();

    for (;;) {
        workspace = createWorkspace({ filePath });
        try {
            workspace.init();
            break;
        } catch (err) {
            if (err && err.code === 'too_new') {
                dialog.showErrorBox('Aventurine Prism',
                    'This plans file was saved by a newer version of Aventurine Prism, so this version cannot open it.'
                    + `\n\n${filePath}\n\nInstall the newer version to open it.`);
                return false;
            }
            if (err && err.code === 'unreadable') {
                const choice = dialog.showMessageBoxSync({
                    type: 'error',
                    buttons: ['Quit', 'Start with a new file'],
                    defaultId: 0,
                    cancelId: 0,
                    noLink: true,
                    title: 'Aventurine Prism',
                    message: 'The plans file could not be read.',
                    detail: `${filePath}\n\nIt has not been changed. Starting with a new file `
                        + 'moves this one aside, beside the original, first.',
                });
                if (choice !== 1) return false;
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                fs.renameSync(filePath, `${filePath}.unreadable-${stamp}`);
                continue;
            }
            throw err;
        }
    }

    const ctx = { workspace, dialogs };

    // The single data channel. The renderer sends HTTP-shaped requests; the
    // backend routes, validates and answers. Requests are only accepted from
    // a frame on the app origin.
    ipcMain.handle('api:request', (e, method, url, body) => {
        if (!fromAppOrigin(e)) return { status: 403, body: { ok: false, error: 'forbidden' } };
        if (typeof method !== 'string' || typeof url !== 'string') {
            return { status: 400, body: { ok: false, error: 'invalid request' } };
        }
        return dispatch(ctx, method, url, body ?? null);
    });
    return true;
}

function fromAppOrigin(e) {
    try {
        const u = new URL(e.senderFrame.url);
        return u.protocol === 'app:' && u.host === APP_HOST;
    } catch {
        return false;
    }
}

// ─── Window controls ────────────────────────────────────────────────────────
// Like every channel, these answer only the app's own page, and each acts on
// the window that page is in rather than on whichever window has focus.

function senderWindow(e) {
    return fromAppOrigin(e) ? BrowserWindow.fromWebContents(e.sender) : null;
}

ipcMain.on('window-min', (e) => senderWindow(e)?.minimize());
ipcMain.on('window-max', (e) => {
    const w = senderWindow(e);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
});
ipcMain.on('window-close', (e) => senderWindow(e)?.close());

// The installed version, for the About tab.
ipcMain.handle('app:version', (e) => {
    if (!fromAppOrigin(e)) throw new Error('app:version: not called from the app page');
    return app.getVersion();
});

// ─── app:// protocol ────────────────────────────────────────────────────────

/** Resolve a decoded URL path inside `root`, rejecting anything that escapes
 *  it ('..' segments, absolute paths). Returns the absolute path or null. */
function safeJoin(root, urlPath) {
    const resolved = path.resolve(root, '.' + path.posix.normalize('/' + urlPath));
    return resolved.startsWith(root + path.sep) || resolved === root ? resolved : null;
}

// Text types get an explicit utf-8 Content-Type, or Chromium falls back to
// windows-1252 for anything without a charset.
const TEXT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.svg':  'image/svg+xml; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

async function serveFile(file) {
    const res = await net.fetch(pathToFileURL(file).href);
    const type = TEXT_TYPES[path.extname(file).toLowerCase()];
    if (!type) return res;
    const headers = new Headers(res.headers);
    headers.set('Content-Type', type);
    return new Response(res.body, { status: res.status, headers });
}

// Shared chrome lives once in pages/partials/ and is spliced in at each
// <!-- @include name --> marker, read fresh per request so Ctrl+R picks up
// partial edits. A missing partial throws, failing the load loudly.
const INCLUDE_RE = /<!--\s*@include\s+([\w-]+)\s*-->/g;

async function servePage(file) {
    const html = (await fs.promises.readFile(file, 'utf8')).replace(
        INCLUDE_RE,
        (_, name) => fs.readFileSync(path.join(PARTIALS_DIR, `${name}.html`), 'utf8'),
    );
    return new Response(html, { status: 200, headers: { 'Content-Type': TEXT_TYPES['.html'] } });
}

function registerAppProtocol() {
    protocol.handle('app', (request) => {
        const url = new URL(request.url);
        if (url.host !== APP_HOST) return new Response('not found', { status: 404 });
        let p;
        try { p = decodeURIComponent(url.pathname); } catch { return new Response('bad request', { status: 400 }); }
        if (Object.prototype.hasOwnProperty.call(PAGE_ROUTES, p)) {
            return servePage(path.join(PAGES_DIR, PAGE_ROUTES[p]));
        }
        if (p.startsWith('/static/')) {
            const file = safeJoin(STATIC_DIR, p.slice('/static/'.length));
            if (file) return serveFile(file);
        }
        return new Response('not found', { status: 404 });
    });
}

// ─── Window ─────────────────────────────────────────────────────────────────

async function createWindow() {
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 680,
        title: 'Aventurine Prism',
        frame: false,
        backgroundColor: '#e5e6e5',
        // The taskbar icon on Linux and Windows; packaged builds also get it
        // from electron-builder.
        icon: path.join(__dirname, 'build', 'icon.png'),
        webPreferences: {
            // Set explicitly so a future Electron default cannot weaken them.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    // One legitimate origin. Deny window.open and block navigation anywhere
    // else, so even a successful injection cannot steer the window (and its
    // bridge) to other content. Compare protocol+host, not URL.origin: Node
    // reports "null" as the origin of any custom scheme.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, navUrl) => {
        let u = null;
        try { u = new URL(navUrl); } catch { /* malformed → block */ }
        if (!u || u.protocol !== 'app:' || u.host !== APP_HOST) e.preventDefault();
    });

    // No camera, microphone, location, notifications or USB.
    const sess = win.webContents.session;
    sess.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    sess.setPermissionCheckHandler(() => false);

    // With the default menu gone, wire reload (and devtools in dev) by hand.
    win.webContents.on('before-input-event', (e, input) => {
        if (input.type !== 'keyDown') return;
        const key = input.key.toLowerCase();
        if (key === 'f5' || (input.control && !input.shift && key === 'r')) {
            e.preventDefault();
            win.webContents.reload();
        } else if (!app.isPackaged && input.control && input.shift && key === 'i') {
            e.preventDefault();
            win.webContents.toggleDevTools();
        }
    });

    // Saves are debounced in the renderer, so an edit made just before closing
    // may not have reached the backend yet. Hold the close until the renderer
    // has flushed (or three seconds pass), then close for real.
    let flushed = false;
    win.on('close', (e) => {
        if (flushed) return;
        e.preventDefault();
        const finish = () => {
            if (flushed || win.isDestroyed()) return;
            flushed = true;
            win.close();
        };
        setTimeout(finish, 3000);
        win.webContents.executeJavaScript('window.Store ? Store.flush() : true', true)
            .catch(() => { /* renderer gone or locked: nothing to flush */ })
            .finally(finish);
    });

    mainWindow = win;
    win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
    await win.loadURL(`${APP_ORIGIN}/`);
    return win;
}

// ─── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    if (!gotSingleInstanceLock) return;
    registerAppProtocol();
    try {
        if (!startBackend()) {
            app.quit();
            return;
        }
    } catch (err) {
        console.error('[electron] backend failed to start:', err);
        dialog.showErrorBox('Aventurine Prism', `The plans file could not be opened:\n${err.message}`);
        app.quit();
        return;
    }
    // Before the window: the About tab asks for the update state as soon as
    // the page runs, and an IPC handler registered after that call is too late.
    initUpdater({ getWindow: () => mainWindow, isAppSender: fromAppOrigin });
    await createWindow();

    app.on('activate', async () => {
        if (BrowserWindow.getAllWindows().length === 0) await createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
    if (workspace) {
        workspace.close();
        workspace = null;
    }
});

'use strict';

// ─── Preload bridge ─────────────────────────────────────────────────────────
//
// Runs in the renderer's isolated world before any page script and exposes a
// small, fixed API through contextBridge. The renderer is sandboxed with
// nodeIntegration off and loads only app:// pages, so this is its only path to
// the main process; keeping it narrow is the point.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('electronWindow', {
    minimize:       () => ipcRenderer.send('window-min'),
    toggleMaximize: () => ipcRenderer.send('window-max'),
    close:          () => ipcRenderer.send('window-close'),
    // 'darwin' | 'win32' | 'linux', read pre-paint by theme-init.js so the
    // title bar dresses its window controls for the platform.
    platform:       process.platform,
    // Scales the whole interface (1 = 100%). Set from Preferences and again
    // at every load by theme-init.js.
    setZoom:        (factor) => webFrame.setZoomFactor(factor),
});

contextBridge.exposeInMainWorld('electronApp', {
    getVersion: () => ipcRenderer.invoke('app:version'),
});

// The data plane. static/js/core/api.js wraps this in a fetch-shaped call; the
// page can pass only (method, url, body). Routing and validation live in the
// main process (electron/backend/), so this stays a dumb pipe.
contextBridge.exposeInMainWorld('citrineApi', {
    request: (method, url, body) => ipcRenderer.invoke('api:request', method, url, body),
});

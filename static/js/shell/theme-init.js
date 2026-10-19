'use strict';

// ─── theme-init.js ──────────────────────────────────────────────────────────
// Applies saved appearance before first paint. A classic blocking <script> in
// <head> (the CSP forbids inline scripts), so the first frame is already the
// right theme.
//
// 'color-theme': '' (light, the default when nothing is stored), 'dark', or
// 'system' (follow the OS; settings.js tracks changes live). Anything else, such
// as the retired 'colorful', is light.
// 'flow-motion': 'off' stops the dots that run along links.
// 'ui-zoom': the interface scale as a factor, 1 when nothing is stored.

(function () {
    const root = document.documentElement;
    let stored = null;
    let motion = null;
    let zoom = null;
    try {
        stored = localStorage.getItem('color-theme');
        motion = localStorage.getItem('flow-motion');
        zoom = Number(localStorage.getItem('ui-zoom'));
    } catch { /* storage unavailable: defaults apply */ }

    const t = stored === 'dark' || stored === 'system' ? stored : '';
    const effective = t === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : '')
        : t;
    if (effective) root.dataset.theme = effective;
    if (motion === 'off') root.dataset.motion = 'off';

    if (window.electronWindow && zoom >= 0.5 && zoom <= 2) window.electronWindow.setZoom(zoom);

    const plat = window.electronWindow && window.electronWindow.platform;
    root.dataset.platform = plat === 'darwin' ? 'mac' : plat === 'win32' ? 'win' : 'linux';
}());

'use strict';

// ─── titlebar.js ────────────────────────────────────────────────────────────
// The window controls (minimize / maximize / close) → preload bridge. The plan
// tabs in the same bar belong to app/tabs.js.

(function () {
    const bar = document.querySelector('.titlebar');
    if (!bar) return;
    bar.addEventListener('click', (e) => {
        const btn = e.target.closest('.titlebar-btn[data-action]');
        const w = window.electronWindow;
        if (!btn || !w) return;
        if (btn.dataset.action === 'min') w.minimize();
        else if (btn.dataset.action === 'max') w.toggleMaximize();
        else if (btn.dataset.action === 'close') w.close();
    });
}());

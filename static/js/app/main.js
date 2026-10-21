'use strict';

// ─── main.js ────────────────────────────────────────────────────────────────
// Boot: load the plans (or show the lock screen), then hand over to the
// modules, which all render from Store events. Also the app-wide shortcuts.

(function () {
    const app = document.getElementById('app');

    async function boot() {
        app.hidden = false;
        try {
            const unlocked = await Store.boot();
            if (!unlocked) {
                app.hidden = true;
                Lock.show(Store.state.status, boot);
            }
        } catch (e) {
            console.error('[boot]', e);
            app.hidden = true;
            UI.toast('Your plans could not be loaded.', { type: 'error', duration: 600000 });
        }
    }

    const typing = (el) => !!el && (el.matches('input, select, textarea') || el.isContentEditable);

    document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (!mod || !Store.state.plan) return;
        const key = e.key.toLowerCase();
        // In a text field, undo belongs to the field.
        if (key === 'z' && !typing(document.activeElement)) {
            e.preventDefault();
            if (e.shiftKey) Store.redo(); else Store.undo();
        } else if (key === 'y' && !typing(document.activeElement)) {
            e.preventDefault();
            Store.redo();
        } else if (key === 't') {
            e.preventDefault();
            Store.newPlan();
        } else if (key === 'tab') {
            e.preventDefault();
            const { tabs, activeId } = Store.state;
            const i = tabs.indexOf(activeId);
            const next = tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
            if (next) Store.openPlan(next);
        } else if (key === ',') {
            e.preventDefault();
            Settings.open();
        } else if (key === 'f' && !typing(document.activeElement)) {
            e.preventDefault();
            Library.focusSearch();
        } else if (key === 's') {
            // Saving is automatic; Ctrl+S just makes it happen now.
            e.preventDefault();
            Store.flush();
        }
    });

    // Format changes redraw every number on screen.
    window.addEventListener('citrine:format', () => {
        Canvas.render();
        Inspector.refresh();
        Outlook.render();
    });

    boot();
}());

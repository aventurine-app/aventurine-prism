'use strict';

// ─── lock.js ────────────────────────────────────────────────────────────────
// The lock screen, shown while the plans cannot be opened yet. Two cases:
//
//   • the desktop plans file is encrypted and not unlocked. The backend answers
//     423 to everything but the file routes until then, so nothing else in the
//     app can load. A correct password reloads the page into the unlocked app.
//   • (web) another tab is editing the plans. Two tabs would overwrite each
//     other, so this one waits; the backend answers /api/file/ready when the
//     other tab is closed, and the app carries on without a reload.

(function () {
    const root = document.getElementById('lockscreen');
    if (!root) return;

    const tabStrip = document.getElementById('tabs');

    /** Wait for the other tab to let go, then call `onReady` to start the app. */
    function showBusy(onReady) {
        root.hidden = false;
        if (tabStrip) tabStrip.hidden = true;
        root.innerHTML = `
            <div class="lock-card" role="status" aria-live="polite">
                <span class="role-tile role-tile--lg role-tile--accent">${iconSvg('copy')}</span>
                <h1 class="lock-title">Prism is open in another tab</h1>
                <p class="lock-note">Plans can be edited in one tab at a time. Close the other tab and your plans will open here.</p>
            </div>`;
        api('GET', '/api/file/ready').then((r) => {
            if (r.ok) {
                root.hidden = true;
                if (tabStrip) tabStrip.hidden = false;
                onReady();
                return;
            }
            root.querySelector('.lock-note').textContent = 'Your plans could not be opened. Reload the page to try again.';
        });
    }

    function show(status, onReady) {
        if (status.reason === 'busy') {
            showBusy(onReady);
            return;
        }
        root.hidden = false;
        // Nothing in the tab strip works until the file is open.
        if (tabStrip) tabStrip.hidden = true;
        root.innerHTML = `
            <form class="lock-card" autocomplete="off">
                <span class="role-tile role-tile--lg role-tile--accent">${iconSvg('lock-key')}</span>
                <h1 class="lock-title">Plans file locked</h1>
                <div class="lock-path"></div>
                <div class="lock-form">
                    <input class="field-input" type="password" name="password" aria-label="Password" placeholder="Password" autocomplete="current-password">
                    <button class="button-primary" type="submit">Unlock</button>
                    <p class="form-error" hidden></p>
                </div>
            </form>`;
        root.querySelector('.lock-path').textContent = status.path || '';
        const form = root.querySelector('form');
        const input = form.elements.password;
        const btn = form.querySelector('button');
        const err = form.querySelector('.form-error');
        input.focus();
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!input.value) return;
            btn.disabled = true;
            btn.classList.add('is-busy');
            err.hidden = true;
            const r = await api('POST', '/api/file/unlock', { password: input.value });
            if (r.ok) {
                location.reload();
                return;
            }
            btn.disabled = false;
            btn.classList.remove('is-busy');
            err.textContent = r.status === 401 ? 'That password is not correct.' : 'The file could not be opened.';
            err.hidden = false;
            input.select();
        });
    }

    window.Lock = { show };
}());

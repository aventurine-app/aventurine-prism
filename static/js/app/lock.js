'use strict';

// ─── lock.js ────────────────────────────────────────────────────────────────
// The lock screen, shown while the plans file is encrypted and not unlocked.
// The backend answers 423 to everything but the file routes until then, so
// nothing else in the app can load. A correct password reloads the page into
// the unlocked app.

(function () {
    const root = document.getElementById('lockscreen');
    if (!root) return;

    function show(status) {
        root.hidden = false;
        // Nothing in the tab strip works until the file is open.
        const tabs = document.getElementById('tabs');
        if (tabs) tabs.hidden = true;
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

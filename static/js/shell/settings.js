'use strict';

// ─── settings.js ────────────────────────────────────────────────────────────
// Preferences: Appearance (surface theme, flow animation, interface zoom), Format (currency
// symbol, its position, digit separators), Security (where the plans file is,
// and encrypting it), About.
//
// Appearance and Format live in localStorage (per machine, read pre-paint by
// theme-init.js and by core/format.js). Encryption is a property of the file
// and goes through the backend. A Format change fires 'citrine:format' so the
// app can redraw its numbers.

(function () {
    const overlay = document.getElementById('prefs');
    const pwOverlay = document.getElementById('pw-modal');
    if (!overlay) return;
    const html = document.documentElement;

    // ── Tabs ───────────────────────────────────────────────────────────────

    const tabs = [...overlay.querySelectorAll('.settings-tab')];

    function selectTab(name) {
        for (const t of tabs) {
            const on = t.dataset.tab === name;
            t.setAttribute('aria-selected', String(on));
            t.tabIndex = on ? 0 : -1;
        }
        overlay.querySelectorAll('.settings-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
        if (name === 'security') refreshSecurity();
        if (name === 'about') refreshAbout();
    }

    overlay.querySelector('.settings-tabs').addEventListener('click', (e) => {
        const t = e.target.closest('.settings-tab');
        if (t) selectTab(t.dataset.tab);
    });
    overlay.querySelector('.settings-tabs').addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        selectTab(next.dataset.tab);
        next.focus();
    });

    // ── Appearance ─────────────────────────────────────────────────────────

    const themeChoice = () => { const s = Prefs.get('color-theme'); return s === 'dark' || s === 'system' ? s : ''; };
    const dark = window.matchMedia('(prefers-color-scheme: dark)');

    function applyTheme(choice) {
        Prefs.set('color-theme', choice);
        const effective = choice === 'system' ? (dark.matches ? 'dark' : '') : choice;
        if (effective) html.dataset.theme = effective;
        else delete html.dataset.theme;
        markTheme();
    }

    function markTheme() {
        const choice = themeChoice();
        overlay.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice)));
    }

    dark.addEventListener('change', () => { if (themeChoice() === 'system') applyTheme('system'); });

    overlay.querySelector('.theme-options').addEventListener('click', (e) => {
        const b = e.target.closest('[data-theme-choice]');
        if (b) applyTheme(b.dataset.themeChoice);
    });

    function markSwitch(name, value) {
        overlay.querySelectorAll(`[data-pref="${name}"] .seg-switch-btn`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
    }

    overlay.querySelector('[data-pref="flow-motion"]').addEventListener('click', (e) => {
        const b = e.target.closest('.seg-switch-btn');
        if (!b) return;
        Prefs.set('flow-motion', b.dataset.value);
        if (b.dataset.value === 'off') html.dataset.motion = 'off';
        else delete html.dataset.motion;
        markSwitch('flow-motion', b.dataset.value);
    });

    const zoomSelect = overlay.querySelector('[data-pref="ui-zoom"]');

    zoomSelect.addEventListener('change', () => {
        Prefs.set('ui-zoom', zoomSelect.value);
        if (window.electronWindow) window.electronWindow.setZoom(Number(zoomSelect.value));
    });

    // ── Format ─────────────────────────────────────────────────────────────

    const formatChanged = () => window.dispatchEvent(new Event('citrine:format'));
    const symbolInput = overlay.querySelector('[data-pref="currency-symbol"]');
    const numberSelect = overlay.querySelector('[data-pref="number-format"]');

    symbolInput.addEventListener('input', () => {
        Fmt.setPref('currency-symbol', symbolInput.value.trim().slice(0, 3));
        formatChanged();
    });
    overlay.querySelector('[data-pref="symbol-position"]').addEventListener('click', (e) => {
        const b = e.target.closest('.seg-switch-btn');
        if (!b) return;
        Fmt.setPref('symbol-position', b.dataset.value);
        markSwitch('symbol-position', b.dataset.value);
        formatChanged();
    });
    numberSelect.addEventListener('change', () => {
        Fmt.setPref('number-format', numberSelect.value);
        formatChanged();
    });

    function refreshAppearance() {
        markTheme();
        markSwitch('flow-motion', Prefs.get('flow-motion', 'on'));
        zoomSelect.value = Prefs.get('ui-zoom', '1');
        symbolInput.value = Fmt.prefs.symbol;
        markSwitch('symbol-position', Fmt.prefs.position);
        numberSelect.value = Fmt.prefs.numberFormat;
    }

    // ── Security ───────────────────────────────────────────────────────────

    async function refreshSecurity() {
        const r = await api('GET', '/api/file/status');
        if (!r.ok) return;
        const s = r.body;
        overlay.querySelector('[data-file-path]').textContent = s.path;
        overlay.querySelector('[data-enc-status]').textContent = s.encrypted ? 'Encrypted' : 'Not encrypted';
        const show = (row, on) => { overlay.querySelector(`[data-enc-row="${row}"]`).hidden = !on; };
        show('encrypt', !s.encrypted);
        show('change', s.encrypted);
        show('lock', s.encrypted);
        show('decrypt', s.encrypted);
    }

    overlay.querySelector('[data-panel="security"]').addEventListener('click', async (e) => {
        const act = e.target.closest('[data-enc-action]');
        if (act) {
            openPassword(act.dataset.encAction);
            return;
        }
        if (e.target.closest('[data-enc-lock]')) {
            // Locking reloads the page, so edits that could not be saved would
            // be lost; Store has already said why, with a Retry.
            if (!(await Store.flush())) return;
            const r = await api('POST', '/api/file/lock');
            if (r.ok) location.reload();
        }
    });

    // ── Password form ──────────────────────────────────────────────────────

    const FIELDS = {
        encrypt: ['new', 'confirm', 'warning'],
        change:  ['current', 'new', 'confirm', 'warning'],
        decrypt: ['current'],
    };
    const TITLES = { encrypt: 'Encrypt Plans File', change: 'Change Password', decrypt: 'Remove Encryption' };
    const ERRORS = {
        wrong_password: 'That password is not correct.',
        password_too_short: 'Use at least 8 characters.',
        password_too_long: 'That password is too long.',
    };

    let pwAction = null;
    const pwForm = document.getElementById('pw-form');
    const pwError = pwOverlay.querySelector('[data-pw-error]');
    const pwSubmit = pwOverlay.querySelector('[data-pw-submit]');

    function openPassword(action) {
        pwAction = action;
        pwForm.reset();
        pwError.hidden = true;
        pwOverlay.querySelector('#pw-title').textContent = TITLES[action];
        pwSubmit.textContent = action === 'decrypt' ? 'Remove' : action === 'change' ? 'Change' : 'Encrypt';
        pwSubmit.className = action === 'decrypt' ? 'button-danger' : 'button-primary';
        pwOverlay.querySelectorAll('[data-pw]').forEach((f) => { f.hidden = !FIELDS[action].includes(f.dataset.pw); });
        UI.openModal(pwOverlay, { initialFocus: pwForm.querySelector('[data-pw]:not([hidden]) input') });
    }

    function fail(message) {
        pwError.textContent = message;
        pwError.hidden = false;
    }

    pwForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const current = pwForm.elements.current.value;
        const password = pwForm.elements.password.value;
        const confirm = pwForm.elements.confirm.value;
        if (pwAction !== 'decrypt') {
            if ([...password].length < 8) return fail(ERRORS.password_too_short);
            if (password !== confirm) return fail('The two new passwords do not match.');
        }
        pwSubmit.disabled = true;
        pwSubmit.classList.add('is-busy');
        await Store.flush();
        const r = await api('POST', '/api/file/encryption', { action: pwAction, current, password });
        pwSubmit.disabled = false;
        pwSubmit.classList.remove('is-busy');
        if (!r.ok) return fail(ERRORS[r.body.error] || 'That did not work. The file is unchanged.');
        UI.closeModal(pwOverlay);
        pwForm.reset();
        refreshSecurity();
        UI.toast(pwAction === 'decrypt' ? 'Encryption removed.' : pwAction === 'change' ? 'Password changed.' : 'Plans file encrypted.', { type: 'success' });
        return undefined;
    });

    // ── About ──────────────────────────────────────────────────────────────

    async function refreshAbout() {
        const el = overlay.querySelector('[data-app-version]');
        try {
            el.textContent = window.electronApp ? await window.electronApp.getVersion() : '—';
        } catch {
            el.textContent = '—';
        }
    }

    function open(tab = 'appearance') {
        refreshAppearance();
        selectTab(tab);
        UI.openModal(overlay, { initialFocus: overlay.querySelector('.settings-tab[aria-selected="true"]') });
    }

    window.Settings = { open };
}());

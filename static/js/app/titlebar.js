'use strict';

// ─── titlebar.js ────────────────────────────────────────────────────────────
// The top bar: whether the plans are saved and the signed-in user at its
// right edge. It also keeps the window title naming the workspace and the plan
// open in it. Plans are listed, opened and managed (exported included) in the
// navigation (nav.js).

(function () {
    const userEl = document.getElementById('titlebar-user');
    const saveEl = document.getElementById('titlebar-save');

    // What each workspace is called here; Plans and Analyze also name the plan.
    const WORKSPACE_NAME = { plans: 'Plans', goals: 'Goals', analyze: 'Analyze', compare: 'Compare' };
    const NAMES_PLAN = new Set(['plans', 'analyze']);

    let drawn = null;

    // Runs on every plan edit (drags included), so it writes only on a change.
    function renderTitle() {
        const { plan, workspace } = Store.state;
        const name = WORKSPACE_NAME[workspace] || 'Plans';
        const planName = plan && NAMES_PLAN.has(workspace) ? plan.name : '';
        const sig = `${name}|${planName}`;
        if (sig === drawn) return;
        drawn = sig;
        document.title = `${planName || name} | Aventurine Prism`;
    }

    // ── Signed-in user ─────────────────────────────────────────────────────
    // The email comes from /api/me. Where there is no server (local dev) or the
    // session is gone, the spot says so. Clicking opens Preferences → Account.
    if (userEl) {
        userEl.innerHTML = `${iconSvg('user-circle')}<span class="titlebar-user-name"></span>`;
        const nameEl = userEl.querySelector('.titlebar-user-name');
        userEl.addEventListener('click', () => Settings.open('account'));
        const show = (email) => {
            nameEl.textContent = email || 'Not signed in';
            userEl.title = email ? `Signed in as ${email}` : 'Account';
            userEl.setAttribute('aria-label', email ? `Account: ${email}` : 'Account');
        };
        show('');
        fetch('/api/me', { credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : null))
            .then((me) => show(me && me.email))
            .catch(() => {});
    }

    // ── Saved ──────────────────────────────────────────────────────────────
    // A status dot and a word, as Ant's Badge: green once every change is in
    // this browser's storage, blue while one is on its way, red if one failed.
    // The words stay short, so the bar does not shift as each edit saves.
    const SAVE = {
        saved: ['success', 'Saved', 'Every change is saved in this browser'],
        saving: ['processing', 'Saving…', 'Saving your changes in this browser'],
        error: ['error', 'Not saved', 'Your latest changes could not be saved'],
    };
    function renderSave() {
        if (!saveEl) return;
        const [tone, text, title] = SAVE[Store.state.save] || SAVE.saved;
        saveEl.className = `titlebar-save badge-dot badge-dot--${tone}`;
        saveEl.textContent = text;
        saveEl.title = title;
    }

    renderTitle();
    renderSave();
    Store.on((c) => {
        if (c.type === 'tabs' || c.type === 'plan' || c.type === 'workspace') renderTitle();
        else if (c.type === 'save') renderSave();
    });
}());

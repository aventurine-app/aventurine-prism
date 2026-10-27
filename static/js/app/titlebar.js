'use strict';

// ─── titlebar.js ────────────────────────────────────────────────────────────
// The top bar: where the user is (the workspace, and the plan open in it), and
// the signed-in user at its right edge. Plans are listed, opened and managed
// (exported included) in the navigation (nav.js).

(function () {
    const titleEl = document.getElementById('titlebar-title');
    const userEl = document.getElementById('titlebar-user');

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
        if (titleEl) {
            titleEl.innerHTML = `<span class="titlebar-where">${escapeHtml(name)}</span>${planName
                ? `${iconSvg('caret-right', { cls: 'titlebar-sep' })}<span class="titlebar-plan">${escapeHtml(planName)}</span>` : ''}`;
        }
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

    renderTitle();
    Store.on((c) => {
        if (c.type === 'tabs' || c.type === 'plan' || c.type === 'workspace') renderTitle();
    });
}());

'use strict';

// ─── account.js ─────────────────────────────────────────────────────────────
// Preferences → Account: who is signed in, what their subscription is, and the
// two things they can do about it (open billing, sign out). It is the one place
// the app talks to the server, and it never sends a plan: only "who am I" and
// the two actions below.
//
// Where there is no server (the local dev server), /api/me does not answer and
// the tab says so instead of failing.

(function () {
    const panel = document.querySelector('[data-panel="account"]');
    if (!panel) return;
    const emailEl = panel.querySelector('[data-account-email]');
    const statusEl = panel.querySelector('[data-account-status]');
    const billingBtn = panel.querySelector('[data-account-billing]');
    const signoutRow = panel.querySelector('[data-account-signout-row]');
    const signoutBtn = panel.querySelector('[data-account-signout]');
    const errorEl = panel.querySelector('[data-account-error]');

    const date = (ms) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });

    /** One plain sentence for a subscription. */
    function describe(me) {
        if (me.complimentary) return 'Complimentary access.';
        const sub = me.subscription;
        if (!sub) return 'No subscription.';
        const until = sub.cancelsAt ? date(sub.cancelsAt) : null;
        switch (sub.status) {
            case 'active':
                if (until) return `Active until ${until}. It will not renew.`;
                return sub.renewsAt ? `Active. Renews ${date(sub.renewsAt)}.` : 'Active.';
            case 'trialing': return 'Free trial.';
            case 'past_due': return 'The last payment failed. Update your payment method to keep access.';
            case 'paused': return 'Paused.';
            case 'canceled': return 'Canceled.';
            default: return 'Not active.';
        }
    }

    function showError(message) {
        errorEl.textContent = message;
        errorEl.hidden = !message;
    }

    async function refresh() {
        showError('');
        billingBtn.hidden = true;
        signoutRow.hidden = true;
        let response;
        try {
            response = await fetch('/api/me', { credentials: 'same-origin' });
        } catch {
            response = null;
        }
        if (!response || !response.ok) {
            emailEl.textContent = '—';
            statusEl.textContent = response && response.status === 401
                ? 'You are signed out. Reload the page to sign in.'
                : 'Not signed in. Accounts are not available in local development.';
            return;
        }
        const me = await response.json();
        emailEl.textContent = me.email;
        statusEl.textContent = describe(me);
        billingBtn.hidden = !me.subscription;
        signoutRow.hidden = false;
    }

    async function post(path) {
        try {
            const response = await fetch(path, {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' }, body: '{}',
            });
            return { ok: response.ok, body: await response.json().catch(() => ({})) };
        } catch {
            return { ok: false, body: {} };
        }
    }

    billingBtn.addEventListener('click', async () => {
        billingBtn.disabled = true;
        billingBtn.classList.add('is-busy');
        showError('');
        const r = await post('/api/billing/portal');
        billingBtn.disabled = false;
        billingBtn.classList.remove('is-busy');
        if (r.ok && r.body.url) {
            window.open(r.body.url, '_blank', 'noopener');
            return;
        }
        showError('Billing could not be opened right now. Try again in a moment.');
    });

    signoutBtn.addEventListener('click', async () => {
        // Saves are debounced, so make sure the last edit is stored before leaving.
        if (window.Store && !(await Store.flush())) return;
        await post('/api/auth/logout');
        location.assign('/auth/login');
    });

    window.Account = { refresh };
}());

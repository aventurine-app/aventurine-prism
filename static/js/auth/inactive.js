'use strict';

// ─── auth/inactive.js ───────────────────────────────────────────────────────
// Where a signed-in person without an active subscription lands. Says why, and
// offers the ways forward: subscribe again, fix billing, or sign out.

(function () {
    const title = document.getElementById('auth-title');
    const note = document.getElementById('inactive-note');
    const error = document.getElementById('inactive-error');
    const pricing = document.getElementById('inactive-pricing');
    const billing = document.getElementById('inactive-billing');
    const signout = document.getElementById('inactive-signout');

    const date = (ms) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });

    function explain(me) {
        const sub = me.subscription;
        if (!sub) return ['No active subscription', `There is no Aventurine Planner subscription for ${me.email}.`];
        if (sub.status === 'paused') return ['Subscription paused', 'Your subscription is paused. Resume it from billing to keep using Aventurine Planner.'];
        if (sub.status === 'canceled') {
            return ['Subscription ended', 'Your subscription has ended. Your plans are still saved in this browser; subscribe again to open them.'];
        }
        return ['Subscription not active', 'Your subscription is not active. Check it in billing.'];
    }

    function showError(message) {
        error.textContent = message;
        error.hidden = false;
    }

    async function load() {
        let me;
        try {
            const response = await fetch('/api/me', { credentials: 'same-origin' });
            if (response.status === 401) {
                location.replace('/auth/login');
                return;
            }
            me = await response.json();
        } catch {
            title.textContent = 'Could not check your subscription';
            note.textContent = 'Reload the page to try again.';
            return;
        }
        if (me.access) {
            location.replace('/');
            return;
        }
        const [heading, text] = explain(me);
        title.textContent = heading;
        note.textContent = me.subscription && me.subscription.renewsAt ? `${text} (Last paid period ended ${date(me.subscription.renewsAt)}.)` : text;
        pricing.hidden = false;
        billing.hidden = !me.subscription;
        signout.hidden = false;
    }

    billing.addEventListener('click', async () => {
        billing.disabled = true;
        error.hidden = true;
        const r = await authPost('/api/billing/portal');
        if (r.status === 200 && r.body.url) {
            location.assign(r.body.url);
            return;
        }
        billing.disabled = false;
        showError('Billing could not be opened right now. Try again in a moment.');
    });

    signout.addEventListener('click', async () => {
        await authPost('/api/auth/logout');
        location.replace('/auth/login');
    });

    load();
}());

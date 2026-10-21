'use strict';

// ─── auth/confirm.js ────────────────────────────────────────────────────────
// Finishes signing in. The emailed link puts its one-time token after a #, which
// the browser never sends to a server. The token is read once, removed from the
// address bar and history, and only sent when the person presses the button.

(function () {
    const note = document.getElementById('confirm-note');
    const error = document.getElementById('confirm-error');
    const button = document.getElementById('confirm-button');
    const retry = document.getElementById('confirm-retry');

    const match = /^#t=([A-Za-z0-9_-]{43})$/.exec(location.hash);
    const token = match ? match[1] : null;
    history.replaceState(null, '', location.pathname);

    function fail(message) {
        note.hidden = true;
        error.textContent = message;
        error.hidden = false;
        button.hidden = true;
        retry.hidden = false;
    }

    if (!token) {
        fail('This sign-in link is not complete. Open the link from your email again, or ask for a new one.');
        return;
    }

    button.addEventListener('click', async () => {
        button.disabled = true;
        button.classList.add('is-busy');
        const r = await authPost('/api/auth/verify', { token });
        if (r.status === 200) {
            location.replace('/');
            return;
        }
        button.disabled = false;
        button.classList.remove('is-busy');
        fail(r.status === 0
            ? 'Could not reach the server. Check your connection, then open the link from your email again.'
            : 'This sign-in link has expired or was already used. Ask for a new one.');
    });
    button.focus();
}());

'use strict';

// ─── auth/login.js ──────────────────────────────────────────────────────────
// The sign-in form: ask for a link by email. The answer is the same whether or
// not the address belongs to a customer, so the page says only that a link is
// on its way if it does.

(function () {
    const form = document.getElementById('login-form');
    const input = document.getElementById('email');
    const error = document.getElementById('login-error');
    const sent = document.getElementById('login-sent');
    const button = form.querySelector('button');

    const MESSAGES = {
        400: 'Enter a valid email address.',
        429: 'Too many attempts. Wait a minute and try again.',
        0: 'Could not reach the server. Check your connection and try again.',
    };

    function showError(message) {
        error.textContent = message;
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        error.hidden = true;
        input.removeAttribute('aria-invalid');
        const email = input.value.trim();
        if (!email) {
            showError(MESSAGES[400]);
            return;
        }
        button.disabled = true;
        button.classList.add('is-busy');
        const r = await authPost('/api/auth/request', { email });
        button.disabled = false;
        button.classList.remove('is-busy');
        if (r.status === 202) {
            sent.hidden = false;
            sent.focus();
            return;
        }
        showError(MESSAGES[r.status] || 'Something went wrong. Try again in a moment.');
    });
}());

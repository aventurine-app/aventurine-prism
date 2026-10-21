// ─── email.js ───────────────────────────────────────────────────────────────
// Sends the sign-in email through Resend's HTTP API. Isolated here so changing
// provider means changing this file only.

const SUBJECT = 'Your Aventurine Prism sign-in link';

export class EmailError extends Error {}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The message body. `link` is built by us from APP_ORIGIN and a random token. */
export function loginMessage(link, minutes) {
    const text = `Open this link to sign in to Aventurine Prism:\n\n${link}\n\n`
        + `It works once and expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.`;
    const html = `<p>Open this link to sign in to Aventurine Prism:</p>`
        + `<p><a href="${escapeHtml(link)}">Sign in to Aventurine Prism</a></p>`
        + `<p>It works once and expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.</p>`;
    return { subject: SUBJECT, text, html };
}

export async function sendLoginEmail({ apiKey, from, to, link, minutes, fetchImpl = fetch }) {
    if (!apiKey || !from) throw new EmailError('email is not configured');
    const message = loginMessage(link, minutes);
    const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], ...message }),
        signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new EmailError(`the email service answered ${response.status}`);
}

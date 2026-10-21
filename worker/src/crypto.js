// ─── crypto.js ──────────────────────────────────────────────────────────────
// The few primitives the worker needs, on WebCrypto. Nothing here is custom
// cryptography: random bytes, SHA-256, HMAC-SHA-256 and a constant-time compare.

const encoder = new TextEncoder();

const toHex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** `bytes` random bytes as URL-safe base64 (no padding). For tokens and ids. */
export function randomToken(bytes = 32) {
    const raw = crypto.getRandomValues(new Uint8Array(bytes));
    let binary = '';
    for (const b of raw) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 of `text` as lower-case hex. Tokens are stored only in this form. */
export async function sha256Hex(text) {
    return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/** HMAC-SHA-256 of `message` under `secret`, as lower-case hex. */
export async function hmacSha256Hex(secret, message) {
    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Compare two strings without stopping at the first difference. */
export function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// ─── config.js ──────────────────────────────────────────────────────────────
// Reads and checks the worker's settings once per request. A bad setting is an
// error here, not a surprise later: the worker refuses to run on a half-set-up
// environment rather than guess (for example, an emailed sign-in link that
// points at the wrong host).
//
//   APP_ORIGIN              where the app is served, e.g. https://app.aventurine-app.com
//   EMAIL_FROM              the From address of sign-in emails
//   PADDLE_API_BASE         https://api.paddle.com (live) or https://sandbox-api.paddle.com
//   COMPLIMENTARY_EMAILS    (secret, optional) emails with free access, comma or space separated
//   PADDLE_WEBHOOK_SECRET, PADDLE_API_KEY, RESEND_API_KEY   (secrets)

const PADDLE_API_BASES = new Set(['https://api.paddle.com', 'https://sandbox-api.paddle.com']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export class ConfigError extends Error {}

function parseOrigin(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new ConfigError('APP_ORIGIN is not a URL');
    }
    const local = LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
        throw new ConfigError('APP_ORIGIN must be https (http is for localhost only)');
    }
    return { origin: url.origin, secure: url.protocol === 'https:' };
}

/** The emails in a comma- or space-separated list, lower-cased. */
export function parseEmailList(value) {
    return new Set(String(value || '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));
}

export function readConfig(env) {
    const { origin, secure } = parseOrigin(env.APP_ORIGIN);
    const paddleApiBase = env.PADDLE_API_BASE || 'https://api.paddle.com';
    if (!PADDLE_API_BASES.has(paddleApiBase)) throw new ConfigError('PADDLE_API_BASE is not a Paddle API host');
    return {
        appOrigin: origin,
        secure,
        emailFrom: env.EMAIL_FROM || '',
        paddleApiBase,
        complimentary: parseEmailList(env.COMPLIMENTARY_EMAILS),
        // Local development has no Paddle: the cookie name and flags follow the scheme.
        cookieName: secure ? '__Host-prism_session' : 'prism_session',
    };
}

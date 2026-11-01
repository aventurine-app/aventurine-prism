// End-to-end check of the worker in Cloudflare's real local runtime (workerd),
// with a throwaway local D1 database and the built app. Drives sign-in, the
// access rule, signed Paddle webhooks and sign-out over HTTP. Needs no secrets
// and touches none of your local state.
//
//   npm run worker:smoke
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8787';
const SECRET = 'pdl_ntfset_local_dev';
const cwd = new URL('..', import.meta.url).pathname;
const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-worker-smoke-'));
// Settings passed on the command line, so no .dev.vars file is needed or read.
const vars = ['APP_ORIGIN:http://127.0.0.1:8787',
    `PADDLE_WEBHOOK_SECRET:${SECRET}`, 'COMPLIMENTARY_EMAILS:test@example.com'].flatMap((v) => ['--var', v]);
let failed = false;
const check = (label, ok, extra = '') => { console.log(`${ok ? 'ok ' : 'FAIL'}  ${label}${ok ? '' : '  ' + extra}`); if (!ok) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(spawnSync('npm', ['run', 'build'], { cwd, env }).stdout.toString().trim().split('\n').pop());
const mig = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'aventurine-prism', '--local', '--persist-to', state, '--config', 'worker/wrangler.toml'], { cwd, env });
console.log('migrations:', mig.status === 0 ? 'applied' : mig.stderr.toString().slice(-400));

let log = '';
const dev = spawn('npx', ['wrangler', 'dev', '--config', 'worker/wrangler.toml', '--port', '8787', '--local', '--persist-to', state, ...vars], { cwd, env });
dev.stdout.on('data', (d) => { log += d; });
dev.stderr.on('data', (d) => { log += d; });

async function waitReady() {
    for (let i = 0; i < 120; i++) {
        try { const r = await fetch(`${BASE}/auth/login`, { redirect: 'manual' }); if (r.status) return true; } catch { /* not up yet */ }
        await sleep(500);
    }
    return false;
}

const req = (path, { method = 'GET', cookie, json, headers = {}, body } = {}) => fetch(`${BASE}${path}`, {
    method, redirect: 'manual',
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { Origin: BASE } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
});

async function signIn(email) {
    const before = log.length;
    const r = await req('/api/auth/request', { method: 'POST', json: { email } });
    await sleep(400);
    const m = /sign-in link for \S+: \S+#t=([A-Za-z0-9_-]{43})/.exec(log.slice(before));
    if (!m) return { status: r.status, cookie: null };
    const v = await req('/api/auth/verify', { method: 'POST', json: { token: m[1] } });
    return { status: v.status, cookie: (v.headers.get('set-cookie') || '').split(';')[0] };
}

async function webhook(event) {
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const h1 = crypto.createHmac('sha256', SECRET).update(`${ts}:${body}`).digest('hex');
    return req('/api/paddle/webhook', { method: 'POST', body, headers: { 'Paddle-Signature': `ts=${ts};h1=${h1}`, 'Content-Type': 'application/json', Origin: '' } });
}

try {
    check('wrangler dev starts', await waitReady(), log.slice(-600));

    let r = await req('/');
    check('signed out, / redirects to sign-in', r.status === 302 && r.headers.get('location') === '/auth/login', `${r.status}`);
    r = await req('/auth/login');
    check('the sign-in page is public', r.status === 200 && (await r.text()).includes('Sign in to Aventurine Planner'));
    r = await req('/static/js/app/store.js');
    check('app code is refused when signed out', r.status === 401);
    r = await req('/static/css/style.css');
    check('stylesheets are public', r.status === 200);
    check('security headers are sent', (r.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'") && r.headers.get('x-content-type-options') === 'nosniff');

    const stranger = await signIn('stranger@example.com');
    check('a stranger gets the same answer and no link', stranger.status === 202 && stranger.cookie === null, JSON.stringify(stranger));

    const owner = await signIn('test@example.com');
    check('the complimentary address signs in', owner.status === 200 && owner.cookie.startsWith('prism_session='), JSON.stringify(owner));
    r = await req('/', { cookie: owner.cookie });
    const page = await r.text();
    check('and receives the app', r.status === 200 && page.includes('<title>Aventurine Planner</title>') && r.headers.get('cache-control') === 'private, no-cache', `${r.status} ${r.headers.get('cache-control')}`);
    r = await req('/static/js/app/store.js', { cookie: owner.cookie });
    check('and its code', r.status === 200 && (await r.text()).includes('window.Store'));

    // A buyer, as Paddle would announce them.
    const at = () => new Date().toISOString();
    const customer = { event_id: 'evt_1', event_type: 'customer.created', occurred_at: at(), data: { id: 'ctm_01smoke', email: 'buyer@example.com' } };
    const sub = (status, type) => ({ event_id: `evt_${status}`, event_type: type, occurred_at: at(), data: { id: 'sub_01smoke', customer_id: 'ctm_01smoke', status, items: [{ price: { id: 'pri_x' } }], current_billing_period: { ends_at: new Date(Date.now() + 30 * 864e5).toISOString() } } });
    r = await webhook(customer);
    check('a signed customer webhook is accepted', r.status === 200, `${r.status} ${await r.text()}`);
    r = await webhook(sub('active', 'subscription.created'));
    check('a signed subscription webhook is accepted', r.status === 200);
    r = await req('/api/paddle/webhook', { method: 'POST', body: '{}', headers: { 'Paddle-Signature': 'ts=1;h1=' + '0'.repeat(64), Origin: '' } });
    check('a forged webhook is refused', r.status === 401);

    const buyer = await signIn('buyer@example.com');
    check('the buyer signs in', buyer.status === 200 && !!buyer.cookie, JSON.stringify(buyer));
    r = await req('/', { cookie: buyer.cookie });
    check('and gets the app', r.status === 200);
    r = await req('/api/me', { cookie: buyer.cookie });
    const me = await r.json();
    check('/api/me reports the subscription', me.access === true && me.subscription.status === 'active', JSON.stringify(me));

    await sleep(1100);
    r = await webhook(sub('canceled', 'subscription.canceled'));
    r = await req('/', { cookie: buyer.cookie });
    check('after cancellation the app closes at once', r.status === 302 && r.headers.get('location') === '/auth/inactive', `${r.status}`);
    r = await req('/auth/inactive');
    check('the inactive page is reachable', r.status === 200);
    r = await req('/api/auth/logout', { method: 'POST', cookie: buyer.cookie, json: {} });
    r = await req('/api/me', { cookie: buyer.cookie });
    check('signing out ends the session', r.status === 401);
} finally {
    dev.kill('SIGTERM');
    await sleep(500);
    fs.rmSync(state, { recursive: true, force: true });
}
console.log(failed ? '\nFAILED' : '\nPASS');
if (failed) console.log(log.slice(-1500));
process.exit(failed ? 1 : 0);

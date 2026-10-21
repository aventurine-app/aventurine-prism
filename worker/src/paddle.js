// ─── paddle.js ──────────────────────────────────────────────────────────────
// Everything that talks to or hears from Paddle.
//
// Webhooks: Paddle POSTs events as customers sign up and pay. We check each one
// really came from Paddle (a signature over the exact bytes received), then
// copy the parts we need into the database. Two events matter:
//
//   customer.created / customer.updated   the customer's id and email
//   subscription.*                        the subscription's id, owner, status and dates
//
// A subscription event carries only a customer id, never an email, so the two
// are joined later by customer id. Paddle may deliver events out of order or
// more than once; store.js applies each only if it is newer than what it holds.
//
// The billing portal: Paddle hosts the page where a customer updates their card
// or cancels. We ask Paddle for a short-lived signed-in link to it.

import { hmacSha256Hex, timingSafeEqual } from './crypto.js';
import { normalizeEmail } from './email-address.js';
import { upsertCustomer, upsertSubscription } from './store.js';
import { json } from './http.js';

const MAX_BODY_BYTES = 512 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 60;

// ── Signature ───────────────────────────────────────────────────────────────

/** Read `ts=…;h1=…` (h1 may repeat while Paddle rotates a secret). Null if malformed. */
export function parseSignatureHeader(header) {
    if (typeof header !== 'string') return null;
    let ts = null;
    const signatures = [];
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) return null;
        const key = part.slice(0, i).trim();
        const value = part.slice(i + 1).trim();
        if (key === 'ts' && /^\d{1,12}$/.test(value)) ts = Number(value);
        else if (key === 'h1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
    }
    return ts === null || !signatures.length ? null : { ts, signatures };
}

/**
 * Did Paddle send this? The signature is an HMAC-SHA-256 of `ts:` + the raw
 * body, so the body must be checked exactly as received, before any parsing.
 * A timestamp far from now is refused, so a captured request cannot be replayed.
 */
export async function verifySignature({ rawBody, header, secret, nowMs }) {
    const parsed = parseSignatureHeader(header);
    if (!parsed || !secret) return false;
    if (Math.abs(nowMs / 1000 - parsed.ts) > SIGNATURE_TOLERANCE_SECONDS) return false;
    const expected = await hmacSha256Hex(secret, `${parsed.ts}:${rawBody}`);
    // Compare against every h1, without stopping early at a match.
    let ok = false;
    for (const candidate of parsed.signatures) ok = timingSafeEqual(expected, candidate) || ok;
    return ok;
}

// ── Events ──────────────────────────────────────────────────────────────────

export class EventError extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const dateMs = (v) => {
    const ms = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isNaN(ms) ? null : ms;
};

/**
 * What to store for an event, or null if it is one we do not use. Throws
 * EventError if it is one we use but it is malformed, so Paddle's dashboard
 * shows the failure instead of us silently storing nonsense.
 */
export function parseEvent(event) {
    if (!isObject(event) || typeof event.event_type !== 'string' || !isObject(event.data)) {
        throw new EventError('not a Paddle event');
    }
    const type = event.event_type;
    const isCustomer = type === 'customer.created' || type === 'customer.updated';
    if (!isCustomer && !type.startsWith('subscription.')) return null;

    const occurredAt = dateMs(event.occurred_at);
    if (occurredAt === null) throw new EventError('missing occurred_at');
    const data = event.data;

    if (isCustomer) {
        const email = normalizeEmail(data.email);
        if (!/^ctm_[a-z0-9]+$/.test(data.id) || !email) throw new EventError('bad customer');
        return { kind: 'customer', id: data.id, email, occurredAt };
    }

    if (!/^sub_[a-z0-9]+$/.test(data.id) || !/^ctm_[a-z0-9]+$/.test(data.customer_id)
        || typeof data.status !== 'string' || !/^[a-z_]{1,24}$/.test(data.status)) {
        throw new EventError('bad subscription');
    }
    const priceId = data.items?.[0]?.price?.id;
    const change = data.scheduled_change;
    return {
        kind: 'subscription',
        id: data.id,
        customerId: data.customer_id,
        status: data.status,
        priceId: typeof priceId === 'string' ? priceId.slice(0, 64) : null,
        periodEnd: dateMs(data.current_billing_period?.ends_at),
        cancelAt: isObject(change) && change.action === 'cancel' ? dateMs(change.effective_at) : null,
        occurredAt,
    };
}

/** The webhook endpoint. Answers 200 only once the event is safely stored. */
export async function handleWebhook({ request, db, secret, nowMs, logger = console }) {
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > MAX_BODY_BYTES) return json({ ok: false, error: 'too_large' }, 413);

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) return json({ ok: false, error: 'too_large' }, 413);

    const header = request.headers.get('Paddle-Signature');
    if (!(await verifySignature({ rawBody, header, secret, nowMs }))) {
        logger.warn('[paddle] webhook refused: bad signature');
        return json({ ok: false, error: 'invalid_signature' }, 401);
    }

    let change;
    try {
        change = parseEvent(JSON.parse(rawBody));
    } catch (e) {
        logger.warn(`[paddle] webhook refused: ${e instanceof EventError ? e.message : 'unreadable body'}`);
        return json({ ok: false, error: 'bad_event' }, 400);
    }
    if (!change) return json({ ok: true, ignored: true });

    if (change.kind === 'customer') await upsertCustomer(db, change);
    else await upsertSubscription(db, change);
    return json({ ok: true });
}

// ── Billing portal ──────────────────────────────────────────────────────────

export class PortalError extends Error {}

/**
 * A signed-in link to Paddle's customer portal, good for a short while. Never
 * stored or reused: ask again each time. Throws PortalError if Paddle refuses.
 */
export async function createPortalLink({ apiBase, apiKey, customerId, subscriptionIds, fetchImpl = fetch }) {
    if (!apiKey) throw new PortalError('no Paddle API key is set');
    let response;
    try {
        response = await fetchImpl(`${apiBase}/customers/${customerId}/portal-sessions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription_ids: subscriptionIds.slice(0, 25) }),
            signal: AbortSignal.timeout(5000),
        });
    } catch {
        throw new PortalError('Paddle could not be reached');
    }
    if (!response.ok) throw new PortalError(`Paddle answered ${response.status}`);
    const body = await response.json().catch(() => null);
    const url = body?.data?.urls?.general?.overview;
    // Only ever hand the browser an https link.
    if (typeof url !== 'string' || !url.startsWith('https://')) throw new PortalError('Paddle sent no link');
    return url;
}

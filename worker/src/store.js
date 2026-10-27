// ─── store.js ───────────────────────────────────────────────────────────────
// Every database statement the worker runs. All values are bound parameters;
// nothing is built from input by string concatenation. `db` is a D1 database
// (or anything with the same prepare/bind/first/all/run shape, which is how the
// tests run it on SQLite).

// ── Billing state, from Paddle webhooks ─────────────────────────────────────
// Paddle does not promise to deliver events in order, so each write carries the
// event's occurred_at and only takes effect if it is newer than what is stored.
// That also makes a repeated delivery a no-op.

export async function upsertCustomer(db, { id, email, occurredAt }) {
    await db.prepare(
        `INSERT INTO customers (id, email, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at
         WHERE excluded.updated_at > customers.updated_at`,
    ).bind(id, email, occurredAt).run();
}

export async function upsertSubscription(db, s) {
    await db.prepare(
        `INSERT INTO subscriptions (id, customer_id, status, price_id, period_end, cancel_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
             customer_id = excluded.customer_id, status = excluded.status, price_id = excluded.price_id,
             period_end = excluded.period_end, cancel_at = excluded.cancel_at, updated_at = excluded.updated_at
         WHERE excluded.updated_at > subscriptions.updated_at`,
    ).bind(s.id, s.customerId, s.status, s.priceId, s.periodEnd, s.cancelAt, s.occurredAt).run();
}

/** The subscriptions of the customer with this email; none for a stranger. */
export async function subscriptionsFor(db, email) {
    const { results } = await db.prepare(
        `SELECT s.status FROM customers c JOIN subscriptions s ON s.customer_id = c.id WHERE c.email = ?`,
    ).bind(email).all();
    return results;
}

/** Is there a Paddle customer with this email? */
export async function hasCustomer(db, email) {
    const row = await db.prepare('SELECT 1 AS found FROM customers WHERE email = ? LIMIT 1').bind(email).first();
    return Boolean(row);
}

// ── Sign-in links ───────────────────────────────────────────────────────────

export async function createLoginToken(db, { tokenHash, email, now, ttlMs }) {
    await db.prepare(
        'INSERT INTO login_tokens (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).bind(tokenHash, email, now, now + ttlMs).run();
}

/** How many links were sent to this email since `since`. */
export async function countLoginTokens(db, { email, since }) {
    const row = await db.prepare(
        'SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?',
    ).bind(email, since).first();
    return row.n;
}

/**
 * Spend a link. One statement, so two clicks racing cannot both succeed.
 * Returns the email it was sent to, or null if it is unknown, used or expired.
 */
export async function consumeLoginToken(db, { tokenHash, now }) {
    const row = await db.prepare(
        `UPDATE login_tokens SET used_at = ?
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
         RETURNING email`,
    ).bind(now, tokenHash, now).first();
    return row ? row.email : null;
}

// ── Sessions ────────────────────────────────────────────────────────────────

export async function createSession(db, { tokenHash, email, now, ttlMs }) {
    await db.prepare(
        'INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).bind(tokenHash, email, now, now + ttlMs).run();
}

/**
 * The live session for a cookie, with that email's subscriptions. One query, so
 * checking access on every request costs a single round trip. Returns null if
 * there is no such session or it has expired.
 */
export async function findSession(db, { tokenHash, now }) {
    const { results } = await db.prepare(
        `SELECT se.email, se.expires_at, su.status, su.period_end, su.cancel_at, su.updated_at
         FROM sessions se
         LEFT JOIN customers c ON c.email = se.email
         LEFT JOIN subscriptions su ON su.customer_id = c.id
         WHERE se.token_hash = ? AND se.expires_at > ?`,
    ).bind(tokenHash, now).all();
    if (!results.length) return null;
    return {
        email: results[0].email,
        expiresAt: results[0].expires_at,
        subscriptions: results.filter((r) => r.status != null),
    };
}

export async function deleteSession(db, tokenHash) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

/** Drop expired links and sessions. Run on a schedule so the tables stay small. */
export async function pruneExpired(db, now) {
    await db.batch([
        db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').bind(now),
        db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    ]);
}

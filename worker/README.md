# Prism worker: sign-in, billing and access

One Cloudflare Worker serves the whole app and decides who may open it. A
visitor signs in by email link; Paddle tells the worker who has paid; the app's
page and scripts go only to someone with an active subscription.

**Plans never touch this server.** They live in the visitor's browser
(`static/js/web/`). The worker knows an email address, whether it has a
subscription, and who is signed in. Nothing else.

## What it does

| Route | Who | Job |
|---|---|---|
| `POST /api/paddle/webhook` | Paddle (signature checked) | Copies customers and subscriptions into the database |
| `POST /api/auth/request` | anyone | Emails a one-time sign-in link, to real customers only |
| `POST /api/auth/verify` | anyone with a link | Spends the link, starts a session |
| `POST /api/auth/logout`, `GET /api/me` | signed in | End the session; who am I and what do I have |
| `POST /api/billing/portal` | signed in | A short-lived link to Paddle's billing page |
| `/auth/login`, `/auth/confirm`, `/auth/inactive`, CSS, fonts, icons | public | The sign-in pages and what they need |
| everything else (`/`, all app JavaScript) | active subscription | The app |

Code map: `src/index.js` (routes and the access rule's enforcement), `paddle.js`
(signature, events, portal), `auth.js` (links and sessions), `access.js` (who
gets in), `store.js` (every SQL statement), `email.js`, `http.js`, `config.js`,
`crypto.js`. Schema: `migrations/`.

## Access rule

A subscription grants access while Paddle says `active`, `trialing` or
`past_due` (a failed renewal that Paddle is still retrying: cutting someone off
for an expired card would be unkind). `paused` and `canceled` do not. A
cancellation the customer asks for stays `active` until the paid period ends,
then Paddle sends `canceled` and access stops on the next request. Addresses in
`COMPLIMENTARY_EMAILS` always have access.

## Run it locally

```bash
cp worker/.dev.vars.example worker/.dev.vars    # then edit
npm run build
npx wrangler d1 migrations apply aventurine-prism --local --config worker/wrangler.toml
npm run worker:dev                              # http://127.0.0.1:8787
```

Open exactly `http://127.0.0.1:8787` (the cookie and the Origin check are tied
to the address in `APP_ORIGIN`). With no `RESEND_API_KEY`, the sign-in link is
printed in the wrangler console. Sign in as your `COMPLIMENTARY_EMAILS` address,
or send yourself a signed webhook (see `scripts/smoke-worker.mjs` for how).

`npm run worker:smoke` runs the whole flow against Cloudflare's real local
runtime with a throwaway database. `npm test` covers the same rules without it.

## Set it up for real

Do all of it against Paddle's **sandbox** first; going live is the last section.

### 1. Cloudflare

```bash
npx wrangler login
npx wrangler d1 create aventurine-prism
```

Put the printed `database_id` in `wrangler.toml`, then create the tables:

```bash
npx wrangler d1 migrations apply aventurine-prism --remote --config worker/wrangler.toml
```

### 2. Domain

The worker works on its `*.workers.dev` address straight away: set `APP_ORIGIN`
to that address and skip to step 3. For `app.aventurine-app.com`, the domain's
DNS has to be on Cloudflare (free: add the site, change the nameservers at your
registrar, and recreate any existing records such as the website's). Then
uncomment `routes` in `wrangler.toml`.

`APP_ORIGIN` must be the exact origin people use. Sign-in links, the session
cookie and the same-origin check all depend on it; a request on any other host
is redirected to it.

### 3. Email (Resend)

1. Create a [Resend](https://resend.com) account and add your sending domain. It
   gives you DNS records (SPF, DKIM) to add at your registrar; this does not need
   the domain on Cloudflare.
2. Create an API key limited to sending, then `npx wrangler secret put RESEND_API_KEY --config worker/wrangler.toml`.
3. Set `EMAIL_FROM` in `wrangler.toml` to an address on that domain.

### 4. Paddle (sandbox)

In the sandbox dashboard:

1. **Catalog → Products**: create "Aventurine Prism" with two recurring prices,
   monthly ($5) and yearly ($50). Note both `pri_…` ids; the website's pricing
   buttons need them.
2. **Developer tools → Authentication**:
   - *API key*: create one with only the `customer_portal_session.write`
     permission. `npx wrangler secret put PADDLE_API_KEY --config worker/wrangler.toml`
   - *Client-side token*: for Paddle.js on the website's pricing page (not a secret).
3. **Events → Notifications → New destination** (not under Developer tools):
   - URL: `<APP_ORIGIN>/api/paddle/webhook`
   - Events: `customer.created`, `customer.updated`, and every `subscription.*`
     event (`created`, `activated`, `updated`, `trialing`, `past_due`, `paused`,
     `resumed`, `canceled`).
   - Copy its secret (`pdl_ntfset_…`; later, Events → Notifications → the destination's menu → Edit destination → the copy icon):
     `npx wrangler secret put PADDLE_WEBHOOK_SECRET --config worker/wrangler.toml`
4. **Checkout → Checkout settings**: set the default payment link and approve the
   website's domain for checkout. Turn the customer portal on.
5. Set `PADDLE_API_BASE` to `https://sandbox-api.paddle.com` in `wrangler.toml`.

Optionally `npx wrangler secret put COMPLIMENTARY_EMAILS` (comma separated) for
yourself and testers.

### 5. Deploy and test

```bash
npm run worker:deploy
```

Then buy with a Paddle sandbox test card on the website, open
`<APP_ORIGIN>/auth/login`, enter the purchase email, and follow the link. Paddle's
**Developer tools → Simulations** can replay cancellations and failed payments.
To see what the worker stored:

```bash
npx wrangler d1 execute aventurine-prism --remote --config worker/wrangler.toml \
  --command "SELECT c.email, s.status, s.period_end FROM subscriptions s JOIN customers c ON c.id = s.customer_id"
```

### 6. Going live

Paddle's live account is separate: repeat step 4 there (live catalog, live API
key, live notification destination), re-set the three Paddle secrets and
`PADDLE_API_BASE=https://api.paddle.com`, use the live client token and price
ids on the website, and deploy again. Buy once with a real card and refund it.

## Things worth knowing

- **Customers who cannot sign in.** The sign-in form only emails addresses that
  Paddle has told us about (`customers` table). If someone says no email
  arrives: check the table above first (a missing row means Paddle's
  `customer.created` was never delivered: see Paddle's notification log), then
  Resend's log, then spam.
- **A different email.** Paddle's `customer.updated` event changes the address
  here too; existing sessions are tied to the old address and stop working.
- **Out-of-order events.** Paddle may deliver webhooks in any order or twice.
  Each write only applies if it is newer than what is stored (`store.js`).
- **Sessions** last 30 days and are checked against the database on every
  request, so a cancellation or `logout` takes effect at once. The app that is
  already open in a tab keeps running until it is reloaded; the plans are local
  either way.
- **Rotating a secret.** Paddle lets two webhook secrets overlap; the worker
  accepts a request if any signature matches. Roll the secret in Paddle, then
  `wrangler secret put PADDLE_WEBHOOK_SECRET`.
- **Rate limits.** Sign-in requests: 10 per minute per IP (the `RATE_LIMIT`
  binding), and at most 3 links per email per 15 minutes.

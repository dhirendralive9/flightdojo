# FlightDojo

Full-stack flight search + booking site for Lazarus Consulting LLC.
Node.js · Express · EJS · MongoDB · Duffel · Stripe · ProxyCheck.io · Nodemailer.

## What's in this build

- **End-to-end booking flow** — passenger details → IP risk gate → embedded payment → 3DS → confirmation email
- **Stripe Elements PaymentElement** embedded on FlightDojo (no Stripe-hosted redirect), full 3DS support, theme-syncs with site light/dark
- **ProxyCheck.io v3** IP risk gate runs *before* PaymentIntent creation — blocks proxies, VPNs, Tor, datacenter IPs, scrapers
- **MongoDB orders** with full audit trail (proxy check result, Stripe IDs, Duffel order, passengers, email status)
- **Stripe webhooks** create the Duffel order and send confirmation email — never relies on the redirect for fulfillment
- **Branded HTML emails** via Nodemailer, inline-styled to match site palette (coral, charcoal, parchment)
- **Cloudflare Turnstile** on search form
- **Smart 366-airport search** with diacritic + alias support
- **Light + dark mode** persists across all pages

## Quick start

```bash
npm install
cp .env.example .env
# fill in keys (see below)
npm start
```

The app boots gracefully with no keys at all — Duffel falls back to mock offers, Stripe falls back to mock intents, MongoDB just logs a warning, ProxyCheck stays permissive, SMTP logs emails to console. **You can preview every page without any external services.**

## The flow

```
/                            → Home with search form
/landing                     → Conversion-focused ads landing
/search?…                    → Live results from Duffel
/offer/:id                   → Detailed offer breakdown
/book/:offerId               → Passenger details + embedded Stripe form
    ↓
POST /api/book/intent        → 1. ProxyCheck v3 IP risk gate
                               2. If allowed: create MongoDB Order
                               3. Create Stripe PaymentIntent
                               4. Return client_secret + reference
    ↓
Client mounts Stripe PaymentElement (in-page, themed)
User submits → stripe.confirmPayment runs 3DS in-iframe
    ↓
return_url → /booking/:reference?payment_intent=…
    ↓
Stripe webhook fires payment_intent.succeeded
    ↓
Backend: duffel.orders.create() → save booking_reference → send email
    ↓
/booking/:reference polls /api/booking/:reference/status
    ↓ (status=booked)
Page reloads → renders success view with PNR + itinerary
```

## Required services

### Duffel (flight inventory + ticketing)
1. Sign up free at https://app.duffel.com (no credit card)
2. Developers → Access Tokens → create a **test** token (starts with `duffel_test_`)
3. `DUFFEL_ACCESS_TOKEN=duffel_test_xxxxx`

### Stripe (payments)
1. https://dashboard.stripe.com/test/apikeys — copy publishable + secret keys
2. `STRIPE_SECRET_KEY=sk_test_xxx` / `STRIPE_PUBLISHABLE_KEY=pk_test_xxx`
3. For webhooks, run `stripe listen --forward-to localhost:3000/webhooks/stripe` and paste the signing secret it prints into `STRIPE_WEBHOOK_SECRET`
4. Test cards:
   - `4242 4242 4242 4242` — instant success, no 3DS
   - `4000 0025 0000 3155` — 3D Secure challenge required
   - `4000 0000 0000 0002` — declined

### ProxyCheck.io v3 (IP risk gate)
1. Free tier (1,000 lookups/day) at https://proxycheck.io/dashboard
2. `PROXYCHECK_API_KEY=xxx-xxx-xxx-xxx`
3. The booking endpoint blocks: `proxy`, `vpn`, `tor`, `scraper`, `hosting`, `anonymous: true`, or `risk_score ≥ 76`
4. Stricter than ProxyCheck's own suggested table — appropriate for a payment endpoint
5. Without a key, the gate runs **permissive** (logs a warning, allows everything) — useful for local dev

### MongoDB (order storage)
- Local: `mongodb://localhost:27017/flightdojo`
- Atlas: `mongodb+srv://user:pass@cluster.mongodb.net/flightdojo`
- Order schema includes proxy_check, passengers, Stripe IDs, Duffel IDs, status timeline

### SMTP (confirmation email)
- **Dev**: sign up at https://mailtrap.io (free) → Inbox → SMTP Settings → copy creds. Mailtrap catches every email so you can preview without sending.
- **Prod**: any SMTP works — SendGrid, Postmark, AWS SES, Resend, your own.
- All emails are inline-styled, fully responsive, brand-matched.

### Cloudflare Turnstile (bot protection on search)
- Defaults to Cloudflare's "always pass" test keys
- Production: get real keys at https://dash.cloudflare.com → Turnstile

## ProxyCheck v3 risk policy

The payment endpoint is stricter than ProxyCheck's default suggestion because we never want to charge a card from an anonymizing network:

| Detection | Action |
|-----------|--------|
| `proxy: true` | **deny** |
| `vpn: true` | **deny** |
| `tor: true` | **deny** |
| `scraper: true` | **deny** |
| `hosting: true` (datacenter) | **deny** |
| `anonymous: true` | **deny** |
| `risk_score >= 76` | **deny** |
| `risk_score 26–75` | challenge (currently denied at payment) |
| everything else | allow |

When denied, the user sees a clear "Payment temporarily blocked" panel naming the reason (VPN / proxy / datacenter etc) instead of a vague error. The check result is persisted on the Order document for auditing.

The service **fails open** if ProxyCheck times out or errors — better to let a legitimate user pay than block every booking during an outage.

## Architecture

```
flightdojo/
├── app.js                       # Express server + routes + webhook
├── models/
│   └── Order.js                 # Mongoose schema with full booking audit
├── services/
│   ├── duffel.js                # Search + offer + orders.create + cache
│   ├── stripe.js                # PaymentIntent + webhook verification
│   ├── proxycheck.js            # v3 IP risk gate with private-IP shortcut
│   ├── mailer.js                # Branded HTML email + Nodemailer transport
│   ├── turnstile.js             # Search form bot protection
│   ├── airports.js              # Smart search w/ aliases & diacritics
│   └── airports-data.js         # 366 curated airports
├── public/
│   ├── css/main.css             # Full design system
│   └── js/
│       ├── main.js              # Theme, search, autocomplete, sort, Turnstile
│       ├── booking.js           # Stripe Elements lifecycle + 3DS
│       └── booking-status.js    # Post-payment status poller
├── views/
│   ├── partials/                # head, navbar, footer, page-header
│   ├── home.ejs · landing.ejs · search-results.ejs · offer-detail.ejs
│   ├── booking-form.ejs         # Passenger form + embedded PaymentElement
│   ├── booking-status.ejs       # Loading / success / failed states
│   ├── about · careers · contact · privacy-policy · disclaimer · refund-policy · terms
│   └── 404.ejs
├── .env.example
└── package.json
```

## Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/` | Home |
| GET | `/landing` | Focused ads landing |
| GET, POST | `/search` | Flight search (POST verifies Turnstile) |
| GET | `/offer/:id` | Offer detail |
| GET | `/book/:offerId` | Passenger form |
| POST | `/api/book/intent` | ProxyCheck → Order → PaymentIntent |
| GET | `/booking/:reference` | Status page (polls) |
| GET | `/api/booking/:reference/status` | JSON status for poll |
| POST | `/webhooks/stripe` | Stripe webhook → Duffel order → email |
| GET | `/api/airports/search?q=` | Autocomplete |

## Going to production

1. **Duffel**: complete identity verification → switch to `duffel_live_xxxxx` token
2. **Stripe**: complete onboarding → switch to live keys, add live webhook endpoint
3. **ProxyCheck**: upgrade past 1k/day if needed ($3.99 for 10k)
4. **MongoDB**: use Atlas or a managed cluster, set strong auth
5. **SMTP**: switch from Mailtrap to a sending provider (SendGrid / Postmark / SES)
6. **Cloudflare Turnstile**: real keys, configure allowed hostnames
7. **NODE_ENV=production**, set strong `STRIPE_WEBHOOK_SECRET`
8. **HTTPS** mandatory — Stripe + ProxyCheck both require it for production keys

## Operator

Lazarus Consulting LLC · Delaware, USA · flightdojo.it.com

# FlightDojo

Precision flight search marketing site + working search engine for Lazarus Consulting LLC.
Built with Node.js, Express, EJS, Duffel API, and protected by Cloudflare Turnstile.

## What's new in this build

- **Cloudflare Turnstile** — bot protection on the search form with theme-responsive widget
- **Duffel API integration** — real flight search via `@duffel/api` SDK
- **Working search form** — autocomplete, real date pickers, swap button, passenger counter
- **Search results page** — sortable offers, carrier logos, full slice/segment display
- **Offer detail page** — full segment breakdown with sticky price summary sidebar
- **Graceful fallbacks** — runs with mock data if `DUFFEL_ACCESS_TOKEN` isn't set; test Turnstile keys by default
- **In-memory caching** — 5-minute TTL on identical searches to protect quota
- **Light & dark mode** with persistence — Turnstile re-renders on theme toggle

## Setup

```bash
npm install
cp .env.example .env
# edit .env and add your Duffel test token:
#   DUFFEL_ACCESS_TOKEN=duffel_test_xxxxx
npm start
```

Server runs at http://localhost:3000

### Getting a Duffel test token

1. Sign up at https://app.duffel.com (free, no credit card)
2. Navigate to **Developers → Access Tokens**
3. Create a token of type **test** — it starts with `duffel_test_`
4. Paste it into `.env`

If no token is set, the app runs in **MOCK mode** showing demo offers so the UI is fully testable without credentials.

## Cloudflare Turnstile

The search form is protected by [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/).
Out of the box it uses Cloudflare's **test sitekey** (`1x00000000000000000000AA`) and **test secret** (`1x0000000000000000000000000000000AA`) that always pass — so you can develop on localhost without setting anything up.

For production, get real keys at https://dash.cloudflare.com → Turnstile → Add Site, then set:

```
TURNSTILE_SITEKEY=0x4AAAAAAA...
TURNSTILE_SECRET=0x4AAAAAAA...
```

Implementation details:
- Explicit-render mode via `turnstile.render()` (gives lifecycle control)
- Theme follows the site's light/dark toggle — widget re-renders on theme change
- `size: flexible` for responsive width
- Server-side token verification via `siteverify` on every POST to `/search`
- Submit button stays disabled until token is issued
- GET `/search` (used for shareable links / route card clicks) skips verification since those aren't user form submissions

## Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/` | GET | Home / full landing with search form, routes, features |
| `/landing` | GET | **Focused, ad-friendly landing page** — animated atmosphere, search + Turnstile, footer menu only |
| `/search?origin=&destination=&depart=&ret=&passengers=&cabin=` | GET | Live flight search results |
| `/search` | POST | Form submission with Turnstile verification |
| `/offer/:id` | GET | Detailed offer view with full segments |
| `/api/airports/search?q=` | GET | JSON autocomplete endpoint |
| `/about`, `/careers`, `/contact`, `/privacy-policy`, `/disclaimer`, `/refund-policy`, `/terms` | GET | Static pages |
| `/contact` | POST | Form submission |

## Architecture

```
flightdojo/
├── app.js                       # Express server + routes
├── services/
│   ├── duffel.js                # Duffel SDK wrapper, normalizer, cache, mock fallback
│   └── airports.js              # Airport database + search/lookup helpers
├── public/
│   ├── css/main.css             # Full design system, light + dark
│   └── js/main.js               # Theme, autocomplete, sort, swap, hamburger
├── views/
│   ├── partials/                # Shared head, nav, footer, page-header
│   ├── home.ejs
│   ├── search-results.ejs       # Live offers list
│   ├── offer-detail.ejs         # Single offer breakdown + summary sidebar
│   ├── about.ejs, careers.ejs, contact.ejs
│   ├── privacy-policy.ejs, disclaimer.ejs, refund-policy.ejs, terms.ejs
│   └── 404.ejs
├── .env.example
└── package.json
```

## Duffel flow used

```
1. User submits search form
   └─→ GET /search?origin=DEL&destination=LHR&depart=2026-08-15&ret=2026-08-22

2. Server calls Duffel SDK:
   duffel.offerRequests.create({
     slices: [{ origin, destination, departure_date }, /* return */],
     passengers: [{ type: 'adult' }, ...],
     cabin_class: 'economy',
     return_offers: true
   })

3. Response is normalized — flatten slices, format durations,
   extract carrier logos, sort by price, cap at 25

4. Result cached 5 min by exact search params, then rendered
```

The offer detail page calls `duffel.offers.get(id)` to fetch the full structure
in case any data is loaded lazily.

## Moving to production

When you're ready to take real bookings:

1. Get a Duffel **live** token (after completing identity verification)
2. Set `DUFFEL_ACCESS_TOKEN=duffel_live_xxxxx` in production env
3. Implement the booking flow: `duffel.orders.create()` with passenger details + payment
4. Add Stripe (or Duffel Payments) for collecting customer payments
5. Set `NODE_ENV=production`

The "Continue to Book" button currently shows a disclaimer — wire it up to a
proper passenger collection form + checkout when ready.

## Operator

Lazarus Consulting LLC · Delaware, USA · flightdojo.it.com

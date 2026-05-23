require('dotenv').config();

const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const { searchOffers, getOffer, getSeatMaps } = require('./services/duffel');
const airportsService = require('./services/airports');
const turnstile = require('./services/turnstile');
const stripeService = require('./services/stripe');
const proxycheck = require('./services/proxycheck');
const geo = require('./services/geo');
const mailer = require('./services/mailer');
const auth = require('./services/auth');
const weather = require('./services/weather');
const Order = require('./models/Order');
const User = require('./models/User');
const Notification = require('./models/Notification');
const PassportDocument = require('./models/PassportDocument');
const EmailLog = require('./models/EmailLog');
const CodeSnippet = require('./models/CodeSnippet');
const codeSnippets = require('./services/code-snippets');

// Multer for passport file uploads — store in memory, 8MB max, jpg/png/pdf only
const passportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WebP, or PDF files allowed.'));
  }
});

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
if (BASE_URL.includes('localhost') && process.env.NODE_ENV === 'production') {
  console.warn('⚠⚠⚠ BASE_URL is set to localhost in production! Emails will contain localhost links.');
  console.warn('    Set BASE_URL=https://flightdojo.it.com in your .env');
}

// ─── MongoDB ─────────────────────────────────────────────
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/flightdojo';
mongoose.connect(mongoUri)
  .then(async () => {
    console.log(`🍃 MongoDB connected: ${mongoUri.replace(/\/\/[^@]*@/, '//***@')}`);
    // Bootstrap admin from env if configured (idempotent)
    try {
      const { bootstrapAdminFromEnv } = require('./scripts/bootstrap-admin');
      await bootstrapAdminFromEnv();
    } catch (err) {
      console.warn('Admin bootstrap failed:', err.message);
    }
  })
  .catch(err => console.warn('⚠  MongoDB connection failed:', err.message, '— orders will not persist'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', true);

// ─── Stack fingerprint suppression ─────────────────────────
// Hide that we're running Express/Node from BuiltWith, Wappalyzer, and similar.
// Removing X-Powered-By is the single biggest signal eliminated.
app.disable('x-powered-by');

// Strip / mask other headers that leak stack info, and add baseline security
// headers while we're at it.
app.use((req, res, next) => {
  // ETag header leaks the underlying engine (weak/strong format differs)
  res.removeHeader('X-Powered-By');
  res.removeHeader('Via');

  // Generic server identity — replace whatever Node/Express would have set
  res.setHeader('Server', 'FlightDojo');

  // Standard security headers (also good for SOC2 / general hardening)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');  // modern browsers ignore but explicit is safer
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(self "https://js.stripe.com")');

  // HSTS only when behind HTTPS — in production, Cloudflare terminates TLS
  // upstream so req.secure is true on real requests. Don't send in local HTTP dev.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Disable ETag generation on app responses — ETag format leaks engine info and
// we don't want browsers / Cloudflare doing 304 revalidation on cache-busted HTML anyway.
app.set('etag', false);

// Static assets: cache long (1 year) — we cache-bust via ?v=<timestamp>
// ETag disabled to avoid leaking engine fingerprint
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1y',
  etag: false,
  lastModified: true
}));

// HTML pages: never cache. The version query string in linked assets must always
// reach the user, so the wrapping HTML cannot be cached by Cloudflare or the browser.
app.use((req, res, next) => {
  const isApi = req.path.startsWith('/api/') || req.path.startsWith('/webhooks/');
  if (!isApi) {
    // Set headers immediately AND wrap res.render so they persist through rendering
    const setNoCache = () => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('CDN-Cache-Control', 'no-store');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
    };
    setNoCache();
    const origRender = res.render.bind(res);
    res.render = function(...args) {
      setNoCache();
      return origRender(...args);
    };
  }
  next();
});

// ─── Stripe webhook MUST be raw before JSON parser ─────────
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ─── Sessions (MongoDB-backed, 30-day rolling) ─────────────
const sessionSecret = process.env.SESSION_SECRET || 'flightdojo-dev-secret-CHANGE-IN-PRODUCTION';
if (sessionSecret.includes('CHANGE-IN-PRODUCTION')) {
  console.warn('⚠  SESSION_SECRET not set — using insecure default. Set a random 32+ char string in .env for production.');
}

// Decide cookie security based on env, NOT on NODE_ENV alone.
// If COOKIE_SECURE is set explicitly ('true' / 'false'), use that.
// Otherwise default to production = secure, dev = insecure.
// This lets you handle Cloudflare Flexible SSL (HTTPS-to-CF, HTTP-to-origin)
// by setting COOKIE_SECURE=false even in production.
let cookieSecure;
if (process.env.COOKIE_SECURE === 'true') cookieSecure = true;
else if (process.env.COOKIE_SECURE === 'false') cookieSecure = false;
else cookieSecure = process.env.NODE_ENV === 'production';

console.log(`🍪 Session cookies: secure=${cookieSecure}, sameSite=lax`);
console.log(`   (override with COOKIE_SECURE=true or COOKIE_SECURE=false in .env)`);

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  },
  store: MongoStore.create({
    mongoUrl: mongoUri,
    ttl: 30 * 24 * 60 * 60,
    autoRemove: 'native'
    // crypto.secret removed — kruptein requires the secret to contain 2+ each
    // of upper/lower/digit/special, and throws null-deref otherwise. Session
    // payload is just {userId} and the Mongo connection is TLS-encrypted in
    // transit, so encrypting the at-rest blob adds risk for negligible benefit.
  })
}));

// Attach req.user + res.locals.user (without enforcing auth) + notification count
app.use(auth.attachUser);

// SEO defaults — populates res.locals.seo on every request. Per-route renders
// can override by passing { seo: { ... } } to res.render().
const seoService = require('./services/seo');
app.use(seoService.attachSeoDefaults);

// Admin-managed code snippets — populates res.locals.snippets_header / snippets_footer
app.use(codeSnippets.attachSnippets);

app.use(async (req, res, next) => {
  if (req.user) {
    try {
      const unread = await Notification.countDocuments({
        user_id: req.user._id,
        read_at: null,
        dismissed_at: null
      });
      res.locals.unread_notifications = unread;
    } catch (e) { res.locals.unread_notifications = 0; }
  }
  next();
});

// ─── REFERRAL COOKIE ───
// If ?ref=CODE is in the URL, store in session so we can apply it at signup time.
app.use((req, res, next) => {
  const ref = req.query.ref;
  if (ref && typeof ref === 'string' && ref.length <= 32 && req.session) {
    const clean = ref.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (clean.length >= 4) {
      req.session.referral_code = clean;
      res.locals.active_referral_code = clean;
    }
  } else if (req.session?.referral_code) {
    res.locals.active_referral_code = req.session.referral_code;
  }
  next();
});

const navLinks = [
  { label: 'Home', href: '/' },
  { label: 'About', href: '/about' },
  { label: 'Careers', href: '/careers' },
  { label: 'Contact', href: '/contact' }
];
const footerLinks = {
  product: [
    { label: 'Search Flights', href: '/' },
    { label: 'Price Alerts', href: '/' },
    { label: 'Charter Flights', href: '/' },
    { label: 'Business Travel', href: '/' }
  ],
  company: [
    { label: 'About', href: '/about' },
    { label: 'Careers', href: '/careers' },
    { label: 'Contact', href: '/contact' }
  ],
  support: [
    { label: 'Refund Policy', href: '/refund-policy' },
    { label: 'Privacy Policy', href: '/privacy-policy' },
    { label: 'Disclaimer', href: '/disclaimer' }
  ]
};

// Generated at boot — invalidates cached static assets when the server restarts
const ASSET_VERSION = String(Date.now());

// Top announcement ribbon (above primary nav). Configurable via .env.
const ribbonConfig = {
  enabled: process.env.RIBBON_ENABLED !== 'false',
  phone_display: process.env.SUPPORT_PHONE_DISPLAY || '+1 (888) 555-0199',
  phone_tel: (process.env.SUPPORT_PHONE_TEL || '+18885550199').replace(/[^\d+]/g, ''),
  message: process.env.RIBBON_MESSAGE || 'Need help booking? Speak with a travel specialist.'
};

app.use((req, res, next) => {
  res.locals.navLinks = navLinks;
  res.locals.footerLinks = footerLinks;
  res.locals.currentPath = req.path;
  res.locals.year = new Date().getFullYear();
  res.locals.turnstileSitekey = turnstile.sitekey;
  res.locals.turnstileTestMode = turnstile.isTestMode;
  res.locals.stripePublishableKey = stripeService.publishableKey;
  res.locals.assetVersion = ASSET_VERSION;
  res.locals.ribbon = ribbonConfig;
  next();
});

function defaultDates() {
  const today = new Date();
  const depart = new Date(today);
  depart.setDate(today.getDate() + 27);
  const ret = new Date(today);
  ret.setDate(today.getDate() + 40);
  return {
    depart: depart.toISOString().slice(0, 10),
    return: ret.toISOString().slice(0, 10)
  };
}

function generateReference() {
  // FD-XXXX-YYYY format, lightly readable
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += chars[crypto.randomBytes(1)[0] % chars.length];
    if (i === 3) s += '-';
  }
  return `FD-${s}`;
}

// Sign an order reference so emails can include a one-click view link without
// requiring login. The token is HMAC-SHA256 over the reference, truncated to
// 16 chars. Anyone who has both the reference AND the token can view the
// order; guessing the token requires breaking HMAC-SHA256.
function signOrderToken(reference) {
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(`order-view:${reference}`)
    .digest('hex')
    .slice(0, 16);
}

function verifyOrderToken(reference, token) {
  if (!reference || !token || typeof token !== 'string') return false;
  const expected = signOrderToken(reference);
  // Constant-time compare (Buffer.compare via timingSafeEqual)
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

// Build a public booking-status URL that works without login.
function buildPublicBookingUrl(reference) {
  const token = signOrderToken(reference);
  return `${process.env.BASE_URL || ''}/booking/${reference}?t=${token}`;
}

// Phone check — keep it simple. Require "+" and at least 9 digits.
// Duffel is the source of truth for what they'll accept; we just shape the input.
function normalizePhone(raw) {
  if (!raw) return { ok: false, error: 'Phone number is required.' };

  let s = String(raw).trim();
  // Accept "00" international prefix as equivalent to "+"
  if (s.startsWith('00')) s = '+' + s.slice(2);

  if (!s.startsWith('+')) {
    return { ok: false, error: 'Please include your country code (e.g. +1, +44, +91).' };
  }

  const digits = s.replace(/\D/g, '');
  if (digits.length < 9) {
    return { ok: false, error: 'Phone number looks too short. Include country code and full number.' };
  }
  if (digits.length > 15) {
    return { ok: false, error: 'Phone number is too long.' };
  }

  return { ok: true, e164: '+' + digits };
}

// ─── PUBLIC PAGES ────────────────────────────────────────
app.get('/', (req, res) => {
  const dates = defaultDates();
  // We render with sensible defaults but client-side JS will hit /api/geo/me
  // immediately to refine origin + popular destinations based on the visitor's IP.
  const defaultOrigin = 'DEL';
  const defaultDest = 'DXB';
  res.render('home', {
    title: 'FlightDojo — Find. Book. Fly.',
    prefill: { origin: defaultOrigin, destination: defaultDest, depart: dates.depart, return: dates.return, passengers: 1 },
    origin_info: airportsService.byIata(defaultOrigin),
    destination_info: airportsService.byIata(defaultDest),
    popular: geo.popularDestinations(null, defaultOrigin)
  });
});

// Geo lookup for the visitor — used by client-side JS to refine the home
// page prefill and popular destinations.
// Cached on the session for the duration of the visit (so we don't hit
// ProxyCheck on every page load).
app.get('/api/geo/me', async (req, res) => {
  // Use session cache if we already looked them up
  if (req.session?.geo_cache && req.session.geo_cache.fetched_at) {
    const age = Date.now() - req.session.geo_cache.fetched_at;
    if (age < 24 * 60 * 60 * 1000) {  // 24h cache
      return res.json({ cached: true, ...req.session.geo_cache.data });
    }
  }

  const ip = proxycheck.clientIp(req);
  let result = null;

  if (ip && !proxycheck.isPrivateOrLocal(ip)) {
    try {
      const ipData = await proxycheck.check(ip, 'geo_lookup');
      result = geo.locateFromIpData(ipData);
      if (result) {
        result.popular = geo.popularDestinations(ipData.country_code, result.origin_iata);
      }
    } catch (err) {
      console.warn('Geo lookup failed:', err.message);
    }
  }

  // If geo failed entirely, return sensible default
  if (!result) {
    result = {
      origin_iata: null,
      method: 'fallback',
      popular: geo.popularDestinations(null, null)
    };
  }

  // Cache on session
  if (req.session) {
    req.session.geo_cache = { fetched_at: Date.now(), data: result };
  }

  res.json(result);
});

app.get('/landing', (req, res) => {
  const dates = defaultDates();
  res.render('landing', {
    title: 'FlightDojo — Search smarter. Fly sharper.',
    prefill: { origin: 'DEL', destination: 'MXP', depart: dates.depart, return: dates.return, passengers: 1 },
    origin_info: airportsService.byIata('DEL'),
    destination_info: airportsService.byIata('MXP')
  });
});

async function handleSearch(req, res) {
  const params = req.method === 'POST' ? req.body : req.query;
  const { origin, destination, depart, ret, passengers, cabin, max_connections } = params;
  const turnstileToken = params['cf-turnstile-response'] || params.turnstile_token;

  if (!origin || !destination || !depart) return res.redirect('/');

  if (req.method === 'POST') {
    const ip = proxycheck.clientIp(req);
    const verification = await turnstile.verify(turnstileToken, ip);
    if (!verification.success) {
      console.warn('Turnstile failed:', verification.error_codes || verification.error);
      return res.status(403).render('search-results', {
        title: 'Verification failed — FlightDojo',
        query: { origin, destination, depart, ret: ret || null, passengers: parseInt(passengers, 10) || 1, cabin: cabin || 'economy' },
        origin_info: airportsService.byIata(origin),
        destination_info: airportsService.byIata(destination),
        results: null,
        error: 'Verification failed. Please refresh the page and try your search again.'
      });
    }
  }

  let results = null;
  let error = null;
  try {
    results = await searchOffers({
      origin: origin.toUpperCase(),
      destination: destination.toUpperCase(),
      depart_date: depart,
      return_date: ret || null,
      passengers: passengers || 1,
      cabin_class: cabin || 'economy',
      max_connections: max_connections || undefined
    });
  } catch (err) {
    console.error('Search error:', err);
    error = err.errors?.[0]?.message || err.message || 'Search failed';
  }

  const originAp = airportsService.byIata(origin);
  const destAp = airportsService.byIata(destination);
  const titleStr = `${origin}→${destination} flights · ${depart} — FlightDojo`;
  const descStr = `Flight search results for ${origin} to ${destination} departing ${depart}${ret ? ', returning ' + ret : ''}. ${parseInt(passengers, 10) || 1} passenger${(parseInt(passengers, 10) || 1) > 1 ? 's' : ''}, ${cabin || 'economy'} class.`;

  res.render('search-results', {
    title: titleStr,
    seo: { ...res.locals.seo, title: titleStr, description: descStr, noindex: true },
    query: {
      origin: origin.toUpperCase(), destination: destination.toUpperCase(),
      depart, ret: ret || null,
      passengers: parseInt(passengers, 10) || 1,
      cabin: cabin || 'economy'
    },
    origin_info: originAp,
    destination_info: destAp,
    results, error
  });
}
app.get('/search', handleSearch);
app.post('/search', handleSearch);

app.get('/offer/:id', async (req, res) => {
  try {
    const { offer } = await getOffer(req.params.id);
    if (!offer) return res.status(404).render('404', { title: '404 — FlightDojo' });
    res.render('offer-detail', {
      title: `Offer ${offer.id} — FlightDojo`,
      offer,
      origin_info: airportsService.byIata(offer.slices[0]?.origin),
      destination_info: airportsService.byIata(offer.slices[0]?.destination)
    });
  } catch (err) {
    console.error('Offer fetch error:', err);
    res.status(500).render('404', { title: 'Error — FlightDojo' });
  }
});

app.get('/api/airports/search', (req, res) => {
  res.json({ results: airportsService.search(req.query.q || '', 8) });
});

// ─── BOOKING FLOW ────────────────────────────────────────

const countries = require('./services/countries');

// Affiliate configuration — links populated from .env, falls back to disabled
const affiliateConfig = {
  airalo: {
    enabled: !!process.env.AIRALO_AFFILIATE_URL,
    url: process.env.AIRALO_AFFILIATE_URL || '',
    headline: 'eSIM for your trip',
    sub: 'Stay connected with mobile data the moment you land.',
    cta: 'Get eSIM'
  },
  lounges: {
    enabled: !!process.env.LOUNGES_AFFILIATE_URL,
    url: process.env.LOUNGES_AFFILIATE_URL || '',
    headline: 'Airport lounge access',
    sub: 'Skip the gate crowds with Wi-Fi, food, and quiet.',
    cta: 'Browse lounges'
  },
  hotels: {
    enabled: !!process.env.HOTELS_AFFILIATE_URL,
    url: process.env.HOTELS_AFFILIATE_URL || '',
    headline: 'Hotels at your destination',
    sub: 'Compare 1M+ properties with free cancellation.',
    cta: 'Find hotels'
  },
  transfers: {
    enabled: !!process.env.TRANSFERS_AFFILIATE_URL,
    url: process.env.TRANSFERS_AFFILIATE_URL || '',
    headline: 'Airport transfers',
    sub: 'Pre-book a private ride from the airport.',
    cta: 'Book transfer'
  },
  insurance: {
    enabled: !!process.env.INSURANCE_AFFILIATE_URL,
    url: process.env.INSURANCE_AFFILIATE_URL || 'https://www.xcover.com/en/insurance/travel',
    headline: 'Travel insurance',
    sub: 'Protect your trip against cancellation, delays, and medical emergencies.',
    cta: 'Get a quote',
    note: 'Coverage is provided by our partner. FlightDojo is not the insurer.'
  }
};

// Step 1: Passenger details form
app.get('/book/:offerId', async (req, res) => {
  try {
    // Fetch offer WITH services so we can show available bags/etc inline
    const { offer } = await getOffer(req.params.offerId, { withServices: true });
    if (!offer) return res.status(404).render('404', { title: '404 — FlightDojo' });

    // Try to fetch seat maps (may not be available for low-cost carriers — that's OK)
    let seatMaps = [];
    let seatMapsUnavailable = false;
    try {
      const smResult = await getSeatMaps(req.params.offerId);
      seatMaps = smResult.seat_maps || [];
      seatMapsUnavailable = !!smResult.unavailable;
    } catch (err) {
      console.warn('Seat-map fetch silently failed:', err.message);
      seatMapsUnavailable = true;
    }

    res.render('booking-form', {
      title: `Book ${offer.slices[0]?.origin} → ${offer.slices[0]?.destination} — FlightDojo`,
      offer,
      countries,
      seat_maps: seatMaps,
      seat_maps_unavailable: seatMapsUnavailable,
      affiliates: affiliateConfig,
      origin_info: airportsService.byIata(offer.slices[0]?.origin),
      destination_info: airportsService.byIata(offer.slices[0]?.destination)
    });
  } catch (err) {
    console.error('Book page error:', err);
    res.status(500).render('404', { title: 'Error — FlightDojo' });
  }
});

// Track an affiliate click — fire-and-forget, used purely for analytics
app.post('/api/affiliate/click', async (req, res) => {
  const { partner, order_reference } = req.body || {};
  if (!partner) return res.json({ ok: false });
  console.log(`🔗 Affiliate click: ${partner}${order_reference ? ' · order ' + order_reference : ''}`);
  // If we have an order reference, attach the click to it
  if (order_reference) {
    try {
      await Order.updateOne(
        { reference: order_reference },
        { $push: { 'addons.affiliate_clicks': { partner, clicked_at: new Date() } } }
      );
    } catch (e) { /* DB optional */ }
  }
  res.json({ ok: true });
});

// Step 2: Submit passenger details → ProxyCheck → Create Order + PaymentIntent
app.post('/api/book/intent', async (req, res) => {
  try {
    const { offer_id, passengers, contact_email, contact_phone } = req.body;

    if (!offer_id || !passengers || !passengers.length || !contact_email) {
      return res.status(400).json({ error: 'missing_fields', message: 'Missing required fields' });
    }

    // ── Server-side passenger validation ──
    // Stripe should never be called with bad data. Duffel rejects missing born_on
    // *after* payment, which would charge the customer for nothing.
    const REQUIRED_PAX_FIELDS = ['title', 'given_name', 'family_name', 'born_on', 'gender'];
    for (let i = 0; i < passengers.length; i++) {
      const p = passengers[i] || {};
      for (const field of REQUIRED_PAX_FIELDS) {
        if (!p[field] || String(p[field]).trim() === '') {
          return res.status(400).json({
            error: 'missing_passenger_field',
            message: `Passenger ${i + 1}: "${field.replace('_', ' ')}" is required.`,
            field,
            passenger_index: i
          });
        }
      }
      // born_on must be YYYY-MM-DD and a real, past date
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.born_on)) {
        return res.status(400).json({
          error: 'invalid_dob_format',
          message: `Passenger ${i + 1}: date of birth must be in YYYY-MM-DD format.`,
          passenger_index: i
        });
      }
      const dob = new Date(p.born_on + 'T00:00:00Z');
      if (isNaN(dob.getTime()) || dob > new Date() || dob.getUTCFullYear() < 1900) {
        return res.status(400).json({
          error: 'invalid_dob',
          message: `Passenger ${i + 1}: date of birth is not a valid past date.`,
          passenger_index: i
        });
      }
      if (!['m', 'f'].includes(String(p.gender).toLowerCase())) {
        return res.status(400).json({
          error: 'invalid_gender',
          message: `Passenger ${i + 1}: gender must be m or f.`,
          passenger_index: i
        });
      }
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact_email)) {
      return res.status(400).json({
        error: 'invalid_email',
        message: 'Please provide a valid contact email.'
      });
    }

    // Phone number — Duffel requires strict E.164 AND a real, dialable number.
    // libphonenumber-js validates against actual country numbering plans.
    const phoneResult = normalizePhone(contact_phone || '');
    if (!phoneResult.ok) {
      return res.status(400).json({
        error: 'invalid_phone',
        message: phoneResult.error
      });
    }
    // Use the normalized E.164 phone everywhere downstream — including the Order
    // doc we save to MongoDB, so the webhook handler picks up the cleaned version.
    const normalizedContactPhone = phoneResult.e164;

    // ───── Billing address validation ─────
    // Required for AVS, chargeback defense, and tax compliance.
    const billing = req.body.billing || {};
    const REQUIRED_BILLING = [
      ['name', 'Cardholder name'],
      ['email', 'Billing email'],
      ['country', 'Country'],
      ['line1', 'Address line 1'],
      ['city', 'City'],
      ['state', 'State / region'],
      ['postal_code', 'ZIP / postal code']
    ];
    for (const [field, label] of REQUIRED_BILLING) {
      const v = billing[field];
      if (!v || String(v).trim() === '') {
        return res.status(400).json({
          error: 'missing_billing_field',
          message: `Billing address: "${label}" is required.`,
          field
        });
      }
    }
    if (!/^[A-Z]{2}$/.test(billing.country)) {
      return res.status(400).json({
        error: 'invalid_country',
        message: 'Billing country must be a 2-letter ISO code.',
        field: 'country'
      });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(billing.email)) {
      return res.status(400).json({
        error: 'invalid_billing_email',
        message: 'Please provide a valid billing email.',
        field: 'email'
      });
    }
    // Trim all string fields for storage hygiene
    const cleanedBilling = {
      name: String(billing.name).trim(),
      email: String(billing.email).trim().toLowerCase(),
      company: billing.company ? String(billing.company).trim() : '',
      country: billing.country.toUpperCase(),
      country_name: billing.country_name || '',
      line1: String(billing.line1).trim(),
      line2: billing.line2 ? String(billing.line2).trim() : '',
      city: String(billing.city).trim(),
      state: String(billing.state).trim(),
      postal_code: String(billing.postal_code).trim(),
      phone: normalizedContactPhone
    };

    // ───── Add-ons (seats, bags, prefs) — optional, no validation beyond shape ─────
    const addonsRaw = req.body.addons || {};
    const addons = {
      seats: Array.isArray(addonsRaw.seats) ? addonsRaw.seats.slice(0, 20).map(s => ({
        passenger_index: parseInt(s.passenger_index, 10) || 0,
        slice_index: parseInt(s.slice_index, 10) || 0,
        designator: typeof s.designator === 'string' ? s.designator.slice(0, 6) : null,
        amount: typeof s.amount === 'string' ? s.amount : '0',
        currency: typeof s.currency === 'string' ? s.currency.slice(0, 3) : '',
        service_id: typeof s.service_id === 'string' ? s.service_id.slice(0, 50) : ''
      })) : [],
      seat_preference_notes: typeof addonsRaw.seat_preference_notes === 'string'
        ? addonsRaw.seat_preference_notes.slice(0, 500).trim() : '',
      bags: Array.isArray(addonsRaw.bags) ? addonsRaw.bags.slice(0, 20).map(b => ({
        passenger_index: parseInt(b.passenger_index, 10) || 0,
        kind: ['checked', 'carry_on'].includes(b.kind) ? b.kind : 'checked',
        max_weight_kg: parseFloat(b.max_weight_kg) || null,
        quantity: parseInt(b.quantity, 10) || 1,
        amount: typeof b.amount === 'string' ? b.amount : '0',
        currency: typeof b.currency === 'string' ? b.currency.slice(0, 3) : '',
        service_id: typeof b.service_id === 'string' ? b.service_id.slice(0, 50) : ''
      })) : [],
      bag_preference_notes: typeof addonsRaw.bag_preference_notes === 'string'
        ? addonsRaw.bag_preference_notes.slice(0, 500).trim() : ''
    };

    // Sum up add-on charges — added to the flight price below
    const addonsTotal = [...addons.seats, ...addons.bags].reduce(
      (sum, x) => sum + (parseFloat(x.amount) || 0), 0
    );
    addons.total_addons_amount = addonsTotal.toFixed(2);

    // ───── SECURITY: ProxyCheck IP gate ─────
    const ip = proxycheck.clientIp(req);
    const proxyResult = await proxycheck.check(ip, 'flightdojo_booking');

    if (proxyResult.recommendation === 'deny') {
      // Persist the rejection too so we can audit/measure
      try {
        await Order.create({
          reference: generateReference(),
          status: 'risk_blocked',
          duffel_offer_id: offer_id,
          contact_email,
          contact_phone: normalizedContactPhone,
          passengers,
          proxy_check: proxyResult,
          failure_reason: `IP risk gate: ${proxyResult.proxy ? 'proxy' : proxyResult.vpn ? 'vpn' : proxyResult.tor ? 'tor' : proxyResult.hosting ? 'datacenter' : proxyResult.scraper ? 'scraper' : 'high-risk'} (score ${proxyResult.risk_score})`
        });
      } catch (e) { /* DB optional */ }

      const reason = proxyResult.proxy ? 'a proxy' :
        proxyResult.vpn ? 'a VPN' :
        proxyResult.tor ? 'the Tor network' :
        proxyResult.hosting ? 'a datacenter / hosting IP' :
        proxyResult.scraper ? 'an automated scraper' :
        'a high-risk network';
      return res.status(403).json({
        error: 'payment_blocked',
        message: `For your security, we can't process payments from ${reason}. Please disable any VPN or proxy and try again from a regular internet connection.`,
        ip_info: {
          country: proxyResult.country,
          isp: proxyResult.isp,
          risk_score: proxyResult.risk_score
        }
      });
    }

    // Fetch fresh offer (Duffel offers expire)
    const { offer } = await getOffer(offer_id);
    if (!offer) return res.status(404).json({ error: 'Offer not found or expired' });

    // Create Order in DB. Charge = flight price + add-ons - applied discount.
    const reference = generateReference();
    const flightAmount = parseFloat(offer.total_amount);
    const subtotal = flightAmount + parseFloat(addons.total_addons_amount);
    const currency = offer.total_currency || 'EUR';

    // ─── APPLY CREDIT IF LOGGED IN AND HAS ONE ───
    let amount = subtotal;
    let appliedDiscount = null;
    if (req.user) {
      const discount = req.user.bestDiscountFor(subtotal);
      if (discount && discount.amount > 0) {
        const discountAmount = Math.round(discount.amount * 100) / 100;
        amount = Math.max(0.01, subtotal - discountAmount); // never zero (Stripe min)
        appliedDiscount = {
          credit_id: discount.credit._id,
          percent_off: discount.percent_off || null,
          fixed_amount: discount.fixed_amount || null,
          amount_off: discountAmount.toFixed(2),
          note: discount.credit.note || (discount.percent_off ? `${(discount.percent_off * 100).toFixed(0)}% off` : `${discount.currency}${discount.fixed_amount} off`)
        };
      }
    }

    let order;
    try {
      order = await Order.create({
        reference,
        status: 'awaiting_payment',
        user_id: req.user?._id || null,
        referred_by_user_id: req.user?.referred_by || null,
        applied_discount: appliedDiscount,
        duffel_offer_id: offer_id,
        total_amount: amount.toFixed(2),
        total_currency: currency,
        base_amount: offer.base_amount,
        tax_amount: offer.tax_amount,
        carrier: offer.carrier,
        carrier_iata: offer.carrier_iata,
        passenger_count: offer.passenger_count,
        slices: offer.slices,
        passengers,
        contact_email,
        contact_phone: normalizedContactPhone,
        billing: cleanedBilling,
        addons,
        proxy_check: proxyResult
      });
    } catch (err) {
      console.warn('Order persistence skipped:', err.message);
      order = { reference, _id: null };
    }

    // Create Stripe PaymentIntent — receipt goes to the billing email
    // so the cardholder gets the Stripe receipt at the correct address.
    const intent = await stripeService.createPaymentIntent({
      amount,
      currency,
      receipt_email: cleanedBilling.email || contact_email,
      billing: cleanedBilling,
      metadata: {
        order_reference: reference,
        duffel_offer_id: offer_id,
        description: `FlightDojo ${offer.slices[0]?.origin} → ${offer.slices[0]?.destination}`,
        billing_country: cleanedBilling.country,
        billing_postal: cleanedBilling.postal_code
      }
    });

    if (order._id) {
      try {
        await Order.updateOne(
          { _id: order._id },
          { stripe_payment_intent_id: intent.id, stripe_amount: intent.amount, stripe_currency: intent.currency }
        );
      } catch (e) { /* ignore */ }
    }

    res.json({
      client_secret: intent.client_secret,
      payment_intent_id: intent.id,
      order_reference: reference,
      order_token: signOrderToken(reference),
      amount,
      currency,
      mock: !!intent._mock
    });
  } catch (err) {
    console.error('Book intent error:', err);
    res.status(500).json({ error: err.message || 'Failed to create payment intent' });
  }
});

// Step 3: After Stripe redirects back, show status
// Public booking-status page. Anyone with EITHER a valid token (sent in the
// confirmation email) OR a matching email (entered via a form) OR an account
// linked to this order can view it. Without any of these we show an email-entry
// form instead of the order details — this prevents enumeration of guessed
// order references.
app.get('/booking/:reference', async (req, res) => {
  const order = await Order.findOne({ reference: req.params.reference }).catch(() => null);

  // No such order → render generic "not found" via the booking-status view
  if (!order) {
    return res.status(404).render('booking-status', {
      title: `Booking ${req.params.reference} — FlightDojo`,
      order: null,
      reference: req.params.reference,
      access_denied: false,
      payment_intent_client_secret: null,
      payment_intent_id: null
    });
  }

  // Check authorization
  const tokenMatch = req.query.t && verifyOrderToken(order.reference, req.query.t);
  const userLinked = req.user && order.user_id && String(order.user_id) === String(req.user._id);
  const isAdmin = req.user && req.user.is_admin;
  const emailMatch = req.query.email &&
    String(req.query.email).trim().toLowerCase() === String(order.contact_email || '').toLowerCase();

  const authorized = tokenMatch || userLinked || isAdmin || emailMatch;

  // Special case: if we have a payment_intent in query, we just came from
  // Stripe redirect (3DS flow) and a token may not be present yet. Allow
  // access — the payment intent metadata is verified during webhook handling
  // anyway, this is just for display.
  const fromStripeRedirect = !!req.query.payment_intent_client_secret;

  if (!authorized && !fromStripeRedirect) {
    return res.status(403).render('booking-status', {
      title: `Booking ${req.params.reference} — FlightDojo`,
      order: null,
      reference: req.params.reference,
      access_denied: true,        // tells the view to render an email-entry form
      contact_email_hint: order.contact_email
        ? order.contact_email.replace(/(.{1,2}).*(@.*)/, '$1***$2')
        : null,
      payment_intent_client_secret: null,
      payment_intent_id: null
    });
  }

  res.render('booking-status', {
    title: `Booking ${req.params.reference} — FlightDojo`,
    order,
    reference: req.params.reference,
    access_denied: false,
    payment_intent_client_secret: req.query.payment_intent_client_secret || null,
    payment_intent_id: req.query.payment_intent || null
  });
});

// Status JSON for poll-while-waiting
app.get('/api/booking/:reference/status', async (req, res) => {
  const order = await Order.findOne({ reference: req.params.reference }).catch(() => null);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({
    reference: order.reference,
    status: order.status,
    booking_reference: order.booking_reference,
    duffel_order_id: order.duffel_order_id,
    email_sent: !!order.email_sent_at,
    failure_reason: order.failure_reason
  });
});

// ─── STRIPE WEBHOOK HANDLER ──────────────────────────────
async function handleStripeWebhook(req, res) {
  let event;
  try {
    event = stripeService.constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (!event) return res.status(400).send('Invalid event');

  console.log('📨 Stripe event:', event.type);

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const reference = pi.metadata?.order_reference;
    if (!reference) {
      console.warn('Webhook: no order_reference in metadata');
      return res.json({ received: true });
    }

    try {
      const order = await Order.findOne({ reference });
      if (!order) {
        console.warn('Webhook: order not found', reference);
        return res.json({ received: true });
      }
      if (order.status === 'booked') {
        console.log('Webhook: order already booked', reference);
        return res.json({ received: true, already: true });
      }

      // Payment confirmed — the order is "booked" from FlightDojo's perspective.
      // We have the customer's money and full passenger details. The actual
      // ticket will be issued manually by the operations team using whatever
      // channel they prefer (consolidator, GDS, direct airline contact, etc.).
      //
      // Our `reference` (FD-XXXX-YYYY) is what the customer uses — they don't
      // see the airline PNR until ops issues the ticket and updates the order.
      order.status = 'booked';
      order.stripe_payment_status = pi.status;
      order.stripe_payment_method = pi.payment_method_types?.[0] || null;
      // Use our own reference as the booking_reference until ops updates it
      // with the airline PNR. The confirmation email shows whichever exists.
      order.booking_reference = order.booking_reference || order.reference;
      await order.save();
      console.log(`✓ Order received ${reference} — pending manual ticketing by ops`);

      // Send confirmation email to the customer
      const sent = await mailer.sendBookingConfirmation(order.toObject());
      if (sent) {
        order.email_sent_at = new Date();
        await order.save();
      }

      // Push an in-app notification if this order is linked to a user
      if (order.user_id) {
        const route = order.slices?.[0] ? `${order.slices[0].origin} → ${order.slices[order.slices.length-1].destination}` : 'your trip';
        Notification.push(order.user_id, {
          type: 'booking_confirmed',
          title: `Booking confirmed · ${route}`,
          body: `We've received your payment for order ${order.reference}. Your airline booking reference will be issued within 2 business hours.`,
          link: `/account/bookings/${order.reference}`,
          order_reference: order.reference
        }).catch(() => {});
      }

      // ─── MARK APPLIED CREDIT AS USED ───
      if (order.user_id && order.applied_discount?.credit_id) {
        try {
          const user = await User.findById(order.user_id);
          if (user) {
            const credit = user.credits.id(order.applied_discount.credit_id);
            if (credit && !credit.used_at) {
              credit.used_at = new Date();
              credit.used_on_order_ref = order.reference;
              await user.save();
              console.log(`💳 Credit ${credit._id} used by ${user.email} on order ${order.reference}`);
            }
          }
        } catch (err) { console.warn('Mark credit used failed:', err.message); }
      }

      // ─── AWARD REFERRAL CREDITS ───
      // If this is the user's first paid booking AND they were referred,
      // award 5% to both referrer + referee for their NEXT booking.
      if (order.user_id && order.referred_by_user_id) {
        try {
          const paidCount = await Order.countDocuments({
            user_id: order.user_id,
            status: { $in: ['booked', 'ticketed', 'completed'] },
            _id: { $ne: order._id }
          });
          if (paidCount === 0) {
            // First successful booking — fire the referral!
            const referee = await User.findById(order.user_id);
            const referrer = await User.findById(order.referred_by_user_id);
            if (referee && referrer) {
              // Give referee 5% off their NEXT booking
              referee.credits.push({
                kind: 'referral_referee',
                percent_off: 0.05,
                earned_from_user_id: referrer._id,
                earned_from_order_ref: order.reference,
                note: '5% off — thanks for joining via a friend\'s link'
              });
              await referee.save();

              // Give referrer 5% off their next booking + increment counter
              referrer.credits.push({
                kind: 'referral_referrer',
                percent_off: 0.05,
                earned_from_user_id: referee._id,
                earned_from_order_ref: order.reference,
                note: `5% off — thanks for referring ${referee.email}`
              });
              referrer.referrals_count = (referrer.referrals_count || 0) + 1;
              await referrer.save();

              Notification.push(referrer._id, {
                type: 'account',
                title: 'You earned 5% off your next booking',
                body: `${referee.name || referee.email} just made their first booking — you've earned 5% off your next trip.`,
                link: '/account/refer'
              }).catch(() => {});

              console.log(`🎁 Referral fulfilled: ${referrer.email} ↔ ${referee.email}`);
            }
          }
        } catch (err) { console.warn('Referral award failed:', err.message); }
      }
    } catch (err) {
      console.error('Webhook processing error:', err);
    }
  } else if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    const reference = pi.metadata?.order_reference;
    if (reference) {
      try {
        await Order.updateOne(
          { reference },
          {
            status: 'failed',
            stripe_payment_status: pi.status,
            failure_reason: pi.last_payment_error?.message || 'Payment failed'
          }
        );
      } catch (e) { /* ignore */ }
    }
  }

  res.json({ received: true });
}

// Diagnostic endpoint — send a test confirmation email to verify SMTP is working.
// Usage: GET /admin/test-email?to=you@example.com
// Protect this in production with an admin key, or remove it entirely.
app.get('/admin/test-email', async (req, res) => {
  const to = req.query.to;
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return res.status(400).json({ error: 'Pass ?to=email@example.com' });
  }
  console.log(`🧪 Test email requested → ${to}`);
  const fakeOrder = {
    reference: 'FD-TEST-' + Math.random().toString(36).slice(2, 6).toUpperCase(),
    booking_reference: 'FD-TEST-1234',
    contact_email: to,
    contact_phone: '+0000000000',
    total_amount: '199.00',
    total_currency: 'EUR',
    base_amount: '150.00',
    tax_amount: '49.00',
    carrier: 'Test Airways',
    carrier_iata: 'TA',
    passenger_count: 1,
    passengers: [{ title: 'mr', given_name: 'Test', family_name: 'User', type: 'adult' }],
    slices: [{
      origin: 'DEL', destination: 'LHR', duration: '9h 30m',
      departure_date: '2026-09-15', stops: 0,
      origin_name: 'Delhi', destination_name: 'London'
    }]
  };
  const sent = await mailer.sendBookingConfirmation(fakeOrder);
  res.json({
    sent,
    to,
    message: sent
      ? 'Email sent — check inbox (and spam folder). If nothing arrives in 5 mins, check Brevo dashboard → Statistics → Email Activity.'
      : 'Send failed. Check the server log for the SMTP error.'
  });
});

// ─── AUTH ROUTES ─────────────────────────────────────────

// Login + signup pages
app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/account');
  res.render('login', {
    title: 'Sign in — FlightDojo',
    next_url: req.query.next || '',
    error: null,
    sent_magic: false
  });
});

app.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/account');
  res.render('signup', {
    title: 'Create account — FlightDojo',
    error: null,
    prefill_email: req.query.email || '',
    next_url: req.query.next || ''
  });
});

// POST signup (also called inline from booking success page)
app.post('/api/account/signup', async (req, res) => {
  const { email, password, name, phone } = req.body || {};
  const result = await auth.signupWithPassword({ email, password, name, phone });
  if (!result.ok) return res.status(400).json({ error: result.error, existing: !!result.existing });

  // ─── REFERRAL PROCESSING ───
  // If user came via a referral link, record the relationship.
  // The actual 5%-off credit is awarded after their first paid booking, NOT now —
  // this prevents people from signing up multiple emails to farm credits.
  let referredBy = null;
  const refCode = req.session?.referral_code;
  if (refCode && result.is_new) {
    try {
      const referrer = await User.findOne({ referral_code: refCode });
      if (referrer && String(referrer._id) !== String(result.user._id)) {
        result.user.referred_by = referrer._id;
        await result.user.save();
        referredBy = referrer;
        console.log(`🎁 Signup ${result.user.email} referred by ${referrer.email}`);
      }
    } catch (err) {
      console.warn('Referral processing failed:', err.message);
    }
  }

  req.session.userId = result.user._id;
  req.session.save(async () => {
    const dashboardUrl = (process.env.BASE_URL || 'http://localhost:3000') + '/account';
    mailer.sendWelcome(result.user, dashboardUrl, result.linked_orders).catch(() => {});

    Notification.push(result.user._id, {
      type: 'account',
      title: 'Welcome to FlightDojo',
      body: referredBy
        ? `Your account is ready. You'll get 5% off your first booking when you check out — thanks to ${referredBy.name || referredBy.email}.`
        : (result.linked_orders > 0
          ? `Your account is ready. We linked ${result.linked_orders} existing booking${result.linked_orders > 1 ? 's' : ''} to your dashboard.`
          : 'Your account is ready. All future bookings will appear here automatically.'),
      link: '/account'
    }).catch(() => {});

    res.json({
      ok: true,
      linked_orders: result.linked_orders,
      redirect: req.body.next || '/account'
    });
  });
});

// POST login
app.post('/api/account/login', async (req, res) => {
  const { email, password } = req.body || {};
  console.log(`🔐 Login attempt: ${email}`);
  const result = await auth.loginWithPassword({ email, password });
  if (!result.ok) {
    console.warn(`🔐 ✗ Login failed for ${email}: ${result.error}`);
    return res.status(401).json({ error: result.error });
  }

  req.session.userId = result.user._id;
  req.session.save((err) => {
    if (err) {
      console.error(`🔐 ✗ Session save failed for ${email}:`, err.message);
      return res.status(500).json({ error: 'Session storage failed. Please try again.' });
    }
    console.log(`🔐 ✓ Login OK for ${email} (session: ${req.session.id.slice(0, 8)}…, secure cookie: ${cookieSecure})`);
    res.json({ ok: true, redirect: req.body.next || '/account' });
  });
});

// POST request magic link
app.post('/api/account/magic-link', async (req, res) => {
  const { email } = req.body || {};
  const result = await auth.startMagicLink({ email });
  if (!result.ok) return res.status(400).json({ error: result.error });

  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const linkUrl = `${baseUrl}/account/magic/${result.token}`;
  mailer.sendMagicLink(result.user, linkUrl).catch(() => {});

  res.json({ ok: true });
});

// GET magic link click
app.get('/account/magic/:token', async (req, res) => {
  const result = await auth.consumeMagicLink(req.params.token);
  if (!result.ok) {
    return res.render('login', {
      title: 'Sign in — FlightDojo',
      next_url: '',
      error: result.error,
      sent_magic: false
    });
  }
  req.session.userId = result.user._id;
  req.session.save(() => res.redirect('/account'));
});

// POST forgot password
app.get('/forgot', (req, res) => {
  res.render('forgot', { title: 'Reset password — FlightDojo', sent: false, error: null });
});
app.post('/api/account/forgot', async (req, res) => {
  const { email } = req.body || {};
  const result = await auth.startPasswordReset({ email });
  if (result.user && result.token) {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const linkUrl = `${baseUrl}/account/reset/${result.token}`;
    mailer.sendPasswordReset(result.user, linkUrl).catch(() => {});
  }
  // Always return success so we don't reveal whether email exists
  res.json({ ok: true });
});

app.get('/account/reset/:token', async (req, res) => {
  res.render('reset-password', {
    title: 'Set new password — FlightDojo',
    token: req.params.token,
    error: null
  });
});
app.post('/api/account/reset/:token', async (req, res) => {
  const { password, password_confirm } = req.body || {};
  if (password !== password_confirm) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  const result = await auth.consumePasswordReset(req.params.token, password);
  if (!result.ok) return res.status(400).json({ error: result.error });

  // Auto-login after successful reset
  req.session.userId = result.user._id;
  req.session.save(() => res.json({ ok: true, redirect: '/account' }));
});

// POST logout
app.post('/api/account/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ─── ACCOUNT DASHBOARD ───────────────────────────────────

app.get('/account', auth.requireAuth, async (req, res) => {
  // Re-link orders in case any came in since last session
  await auth.linkOrdersToUser(req.user);

  const orders = await Order.find({ user_id: req.user._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  // Split into upcoming vs past based on first slice's date
  const now = new Date();
  const upcoming = [];
  const past = [];
  for (const o of orders) {
    const firstDate = o.slices?.[0]?.departure_date;
    const trip = firstDate ? new Date(firstDate + 'T00:00:00Z') : null;
    if (trip && trip >= now && o.status !== 'cancelled') {
      upcoming.push(o);
    } else {
      past.push(o);
    }
  }

  res.render('account/dashboard', {
    title: 'My trips — FlightDojo',
    upcoming,
    past,
    active_section: 'trips'
  });
});

app.get('/account/bookings/:reference', auth.requireAuth, async (req, res) => {
  const order = await Order.findOne({
    reference: req.params.reference,
    user_id: req.user._id
  }).lean();
  if (!order) return res.status(404).render('404', { title: '404 — FlightDojo' });

  res.render('account/trip-detail', {
    title: `Trip ${order.reference} — FlightDojo`,
    order,
    active_section: 'trips'
  });
});

app.get('/account/settings', auth.requireAuth, async (req, res) => {
  res.render('account/settings', {
    title: 'Account settings — FlightDojo',
    active_section: 'settings',
    saved: req.query.saved === '1',
    error: null
  });
});

app.post('/api/account/settings', auth.requireAuth, async (req, res) => {
  const { name, phone, default_billing } = req.body || {};
  try {
    if (typeof name === 'string') req.user.name = name.trim().slice(0, 100);
    if (typeof phone === 'string') req.user.phone = phone.trim().slice(0, 30);
    if (default_billing && typeof default_billing === 'object') {
      req.user.default_billing = {
        name: String(default_billing.name || '').trim(),
        company: String(default_billing.company || '').trim(),
        country: String(default_billing.country || '').trim().toUpperCase(),
        country_name: String(default_billing.country_name || '').trim(),
        line1: String(default_billing.line1 || '').trim(),
        line2: String(default_billing.line2 || '').trim(),
        city: String(default_billing.city || '').trim(),
        state: String(default_billing.state || '').trim(),
        postal_code: String(default_billing.postal_code || '').trim(),
        phone: String(default_billing.phone || '').trim()
      };
    }
    await req.user.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/account/change-password', auth.requireAuth, async (req, res) => {
  const { current_password, new_password, new_password_confirm } = req.body || {};
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  if (new_password !== new_password_confirm) {
    return res.status(400).json({ error: 'New passwords do not match.' });
  }
  // If they already have a password, require current one. If they don't (magic-link-only user), allow setting one.
  if (req.user.password_hash) {
    const valid = await req.user.checkPassword(current_password || '');
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  await req.user.setPassword(new_password);
  await req.user.save();
  res.json({ ok: true });
});

// ─── NOTIFICATIONS ──────────────────────────────────────

app.get('/account/notifications', auth.requireAuth, async (req, res) => {
  const notifications = await Notification.find({
    user_id: req.user._id,
    dismissed_at: null
  }).sort({ createdAt: -1 }).limit(50).lean();
  res.render('account/notifications', {
    title: 'Notifications — FlightDojo',
    notifications,
    active_section: 'notifications'
  });
});

app.post('/api/account/notifications/:id/read', auth.requireAuth, async (req, res) => {
  await Notification.updateOne(
    { _id: req.params.id, user_id: req.user._id },
    { read_at: new Date() }
  );
  res.json({ ok: true });
});

app.post('/api/account/notifications/read-all', auth.requireAuth, async (req, res) => {
  await Notification.updateMany(
    { user_id: req.user._id, read_at: null },
    { read_at: new Date() }
  );
  res.json({ ok: true });
});

app.post('/api/account/notifications/:id/dismiss', auth.requireAuth, async (req, res) => {
  await Notification.updateOne(
    { _id: req.params.id, user_id: req.user._id },
    { dismissed_at: new Date(), read_at: new Date() }
  );
  res.json({ ok: true });
});

// ─── SAVED TRAVELERS ─────────────────────────────────────

app.get('/account/travelers', auth.requireAuth, async (req, res) => {
  res.render('account/travelers', {
    title: 'Saved travelers — FlightDojo',
    travelers: req.user.saved_travelers || [],
    active_section: 'travelers'
  });
});

app.post('/api/account/travelers', auth.requireAuth, async (req, res) => {
  const { title, given_name, family_name, born_on, gender, relationship } = req.body || {};
  if (!given_name || !family_name) {
    return res.status(400).json({ error: 'First and last name are required.' });
  }
  req.user.saved_travelers.push({
    title: String(title || 'mr').toLowerCase(),
    given_name: String(given_name).trim().slice(0, 80),
    family_name: String(family_name).trim().slice(0, 80),
    born_on: typeof born_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(born_on) ? born_on : '',
    gender: ['m', 'f'].includes((gender || '').toLowerCase()) ? gender.toLowerCase() : 'm',
    relationship: String(relationship || 'other').trim().slice(0, 30)
  });
  await req.user.save();
  res.json({ ok: true, traveler: req.user.saved_travelers[req.user.saved_travelers.length - 1] });
});

app.put('/api/account/travelers/:id', auth.requireAuth, async (req, res) => {
  const t = req.user.saved_travelers.id(req.params.id);
  if (!t) return res.status(404).json({ error: 'Traveler not found.' });
  const { title, given_name, family_name, born_on, gender, relationship } = req.body || {};
  if (title !== undefined) t.title = String(title).toLowerCase();
  if (given_name !== undefined) t.given_name = String(given_name).trim().slice(0, 80);
  if (family_name !== undefined) t.family_name = String(family_name).trim().slice(0, 80);
  if (born_on !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(born_on)) t.born_on = born_on;
  if (gender !== undefined && ['m', 'f'].includes((gender || '').toLowerCase())) t.gender = gender.toLowerCase();
  if (relationship !== undefined) t.relationship = String(relationship).trim().slice(0, 30);
  await req.user.save();
  res.json({ ok: true });
});

app.delete('/api/account/travelers/:id', auth.requireAuth, async (req, res) => {
  const t = req.user.saved_travelers.id(req.params.id);
  if (!t) return res.status(404).json({ error: 'Traveler not found.' });
  t.deleteOne();
  await req.user.save();
  // Also unlink any passports referencing this traveler (passports stay, but become unassigned)
  await PassportDocument.updateMany(
    { user_id: req.user._id, traveler_id: req.params.id },
    { traveler_id: null }
  );
  res.json({ ok: true });
});

// Public-ish endpoint to list saved travelers for autofill on booking form
app.get('/api/account/travelers', auth.requireAuth, async (req, res) => {
  res.json({ travelers: req.user.saved_travelers || [] });
});

// ─── PASSPORTS ───────────────────────────────────────────

app.post('/api/account/passports', auth.requireAuth, passportUpload.single('passport'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const { traveler_id } = req.body || {};

  const { ciphertext, iv, tag, encrypted } = PassportDocument.encryptBuffer(req.file.buffer);

  const doc = await PassportDocument.create({
    user_id: req.user._id,
    traveler_id: traveler_id || null,
    filename: req.file.originalname.slice(0, 200),
    mime_type: req.file.mimetype,
    size_bytes: req.file.size,
    data: ciphertext,
    iv, tag, encrypted
  });

  res.json({
    ok: true,
    document: {
      id: doc._id,
      filename: doc.filename,
      mime_type: doc.mime_type,
      size_bytes: doc.size_bytes,
      traveler_id: doc.traveler_id,
      encrypted: doc.encrypted,
      createdAt: doc.createdAt
    }
  });
});

app.get('/api/account/passports', auth.requireAuth, async (req, res) => {
  const docs = await PassportDocument.find({ user_id: req.user._id })
    .select('-data -iv -tag')
    .sort({ createdAt: -1 })
    .lean();
  res.json({ passports: docs });
});

// Download/view a passport (returns the file inline if image, attachment if PDF)
app.get('/account/passports/:id/file', auth.requireAuth, async (req, res) => {
  const doc = await PassportDocument.findOne({ _id: req.params.id, user_id: req.user._id });
  if (!doc) return res.status(404).send('Not found');
  const buf = doc.encrypted
    ? PassportDocument.decryptBuffer(doc.data, doc.iv, doc.tag)
    : doc.data;
  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
  // Don't cache passport content
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
});

app.delete('/api/account/passports/:id', auth.requireAuth, async (req, res) => {
  await PassportDocument.deleteOne({ _id: req.params.id, user_id: req.user._id });
  res.json({ ok: true });
});

// ─── PAYMENT METHODS ─────────────────────────────────────

app.get('/account/payment-methods', auth.requireAuth, async (req, res) => {
  const methods = await stripeService.listPaymentMethods(req.user.email);
  res.render('account/payment-methods', {
    title: 'Payment methods — FlightDojo',
    methods,
    active_section: 'payment-methods'
  });
});

app.delete('/api/account/payment-methods/:id', auth.requireAuth, async (req, res) => {
  // Confirm the PM actually belongs to this user (via their Stripe customer)
  const methods = await stripeService.listPaymentMethods(req.user.email);
  if (!methods.find(m => m.id === req.params.id)) {
    return res.status(404).json({ error: 'Payment method not found.' });
  }
  const result = await stripeService.detachPaymentMethod(req.params.id);
  res.json(result);
});

// ─── DAY-OF-TRAVEL DATA (weather + tips) ─────────────────

app.get('/api/account/bookings/:reference/travel-day', auth.requireAuth, async (req, res) => {
  const order = await Order.findOne({
    reference: req.params.reference,
    user_id: req.user._id
  }).lean();
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  // Only return travel-day info if departure is in the next 7 days
  const firstSlice = order.slices?.[0];
  if (!firstSlice?.departure_date) return res.json({ show: false });

  const dep = new Date(firstSlice.departure_date + 'T00:00:00Z');
  const hoursUntil = (dep - Date.now()) / (1000 * 60 * 60);
  if (hoursUntil > 7 * 24 || hoursUntil < -24) {
    return res.json({ show: false, hours_until: Math.round(hoursUntil) });
  }

  const destinationIata = order.slices[order.slices.length - 1].destination;
  const weatherSnapshot = await weather.forDestination(destinationIata);

  res.json({
    show: true,
    hours_until: Math.round(hoursUntil),
    destination: destinationIata,
    destination_name: order.slices[order.slices.length - 1].destination_name,
    weather: weatherSnapshot,
    checklist: [
      { id: 'passport', label: 'Passport (and visa if required)', critical: true },
      { id: 'tickets', label: 'Booking reference saved offline', critical: true },
      { id: 'insurance', label: 'Travel insurance documents' },
      { id: 'chargers', label: 'Phone charger + power bank' },
      { id: 'adapter', label: 'Power adapter for destination' },
      { id: 'meds', label: 'Prescriptions and basic medications' },
      { id: 'cash', label: 'Local currency / debit card with no FX fees' },
      { id: 'checkin', label: `Online check-in (opens 24h before for ${order.carrier_iata || 'most airlines'})` }
    ]
  });
});

// ─── REFERRALS ────────────────────────────────────────────

app.get('/account/refer', auth.requireAuth, async (req, res) => {
  const baseUrl = process.env.BASE_URL || `http://${req.hostname}:3000`;
  const referralUrl = `${baseUrl}/?ref=${req.user.referral_code}`;

  // Active (unused) credits
  const activeCredits = req.user.getActiveCredits();
  // History — recent referrals you've completed
  const completedReferrals = await User.find({ referred_by: req.user._id })
    .select('email name createdAt')
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  res.render('account/refer', {
    title: 'Refer a friend — FlightDojo',
    active_section: 'refer',
    referral_url: referralUrl,
    referral_code: req.user.referral_code,
    referrals_count: req.user.referrals_count || 0,
    active_credits: activeCredits,
    completed_referrals: completedReferrals
  });
});

// ─── SAVED SEARCHES ──────────────────────────────────────

const SavedSearch = require('./models/SavedSearch');

app.get('/account/saved-searches', auth.requireAuth, async (req, res) => {
  const searches = await SavedSearch.find({
    user_id: req.user._id,
    archived_at: null
  }).sort({ createdAt: -1 }).limit(50).lean();

  res.render('account/saved-searches', {
    title: 'Saved searches — FlightDojo',
    active_section: 'saved-searches',
    searches
  });
});

app.post('/api/account/saved-searches', auth.requireAuth, async (req, res) => {
  const { origin, destination, depart_date, return_date, passengers, cabin_class, baseline_price, baseline_currency } = req.body || {};
  if (!origin || !destination || !depart_date) {
    return res.status(400).json({ error: 'Origin, destination, and departure date are required.' });
  }

  // Look up airport names for nicer dashboard display
  const originAp = airportsService.byIata(String(origin).toUpperCase());
  const destAp = airportsService.byIata(String(destination).toUpperCase());

  try {
    const search = await SavedSearch.create({
      user_id: req.user._id,
      origin: String(origin).toUpperCase(),
      destination: String(destination).toUpperCase(),
      depart_date,
      return_date: return_date || null,
      passengers: parseInt(passengers, 10) || 1,
      cabin_class: cabin_class || 'economy',
      origin_name: originAp?.city || originAp?.name || '',
      destination_name: destAp?.city || destAp?.name || '',
      baseline_price: baseline_price ? parseFloat(baseline_price) : null,
      baseline_currency: baseline_currency || 'USD',
      current_price: baseline_price ? parseFloat(baseline_price) : null,
      current_currency: baseline_currency || 'USD',
      last_checked_at: new Date()
    });
    res.json({ ok: true, id: search._id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/account/saved-searches/:id', auth.requireAuth, async (req, res) => {
  await SavedSearch.updateOne(
    { _id: req.params.id, user_id: req.user._id },
    { archived_at: new Date(), active: false }
  );
  res.json({ ok: true });
});

// Manual "check now" — re-run search via Duffel and update price
app.post('/api/account/saved-searches/:id/check', auth.requireAuth, async (req, res) => {
  const search = await SavedSearch.findOne({ _id: req.params.id, user_id: req.user._id });
  if (!search) return res.status(404).json({ error: 'Not found' });

  try {
    const result = await searchOffers({
      origin: search.origin,
      destination: search.destination,
      depart_date: search.depart_date,
      return_date: search.return_date,
      passengers: search.passengers,
      cabin_class: search.cabin_class
    });
    const cheapest = (result.offers || []).reduce((min, o) =>
      !min || parseFloat(o.total_amount) < parseFloat(min.total_amount) ? o : min, null);

    if (!cheapest) {
      search.last_checked_at = new Date();
      await search.save();
      return res.json({ ok: true, no_results: true });
    }

    const newPrice = parseFloat(cheapest.total_amount);
    const oldPrice = search.current_price || search.baseline_price || newPrice;
    const dropPct = oldPrice > 0 ? (oldPrice - newPrice) / oldPrice : 0;

    search.current_price = newPrice;
    search.current_currency = cheapest.total_currency;
    search.last_offer_id = cheapest.id;
    search.last_checked_at = new Date();
    if (!search.baseline_price) {
      search.baseline_price = newPrice;
      search.baseline_currency = cheapest.total_currency;
    }
    await search.save();

    res.json({
      ok: true,
      price: newPrice,
      currency: cheapest.total_currency,
      old_price: oldPrice,
      drop_percent: Math.round(dropPct * 100),
      offer_id: cheapest.id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GROUPS ──────────────────────────────────────────────

const Group = require('./models/Group');

app.get('/account/groups', auth.requireAuth, async (req, res) => {
  const groups = await Group.find({
    $or: [
      { owner_id: req.user._id },
      { 'members.user_id': req.user._id }
    ]
  }).sort({ createdAt: -1 }).lean();

  res.render('account/groups', {
    title: 'Groups — FlightDojo',
    active_section: 'groups',
    groups
  });
});

app.get('/account/groups/:id', auth.requireAuth, async (req, res) => {
  const group = await Group.findOne({
    _id: req.params.id,
    $or: [
      { owner_id: req.user._id },
      { 'members.user_id': req.user._id }
    ]
  }).populate('members.user_id', 'name email').lean();
  if (!group) return res.status(404).render('404', { title: '404 — FlightDojo' });

  // All trips for this group
  const memberIds = group.members.map(m => m.user_id?._id).filter(Boolean);
  const orders = await Order.find({
    $or: [
      { group_id: group._id },
      { user_id: { $in: memberIds } }
    ]
  }).sort({ createdAt: -1 }).limit(50).lean();

  res.render('account/group-detail', {
    title: `${group.name} — FlightDojo`,
    active_section: 'groups',
    group,
    orders,
    is_owner: String(group.owner_id) === String(req.user._id)
  });
});

app.post('/api/account/groups', auth.requireAuth, async (req, res) => {
  const { name, icon } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Group name is required.' });

  const group = await Group.create({
    name: String(name).trim().slice(0, 80),
    icon: icon ? String(icon).slice(0, 8) : '👥',
    owner_id: req.user._id,
    members: [{ user_id: req.user._id, role: 'owner' }]
  });
  res.json({ ok: true, id: group._id });
});

app.delete('/api/account/groups/:id', auth.requireAuth, async (req, res) => {
  const group = await Group.findOne({ _id: req.params.id, owner_id: req.user._id });
  if (!group) return res.status(404).json({ error: 'Group not found or you are not the owner.' });

  // Detach any orders that were linked to this group (don't delete the orders!)
  await Order.updateMany({ group_id: group._id }, { group_id: null });
  await Group.deleteOne({ _id: group._id });
  res.json({ ok: true });
});

app.post('/api/account/groups/:id/invite', auth.requireAuth, async (req, res) => {
  const { email, role } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required.' });
  }
  const group = await Group.findOne({ _id: req.params.id, owner_id: req.user._id });
  if (!group) return res.status(404).json({ error: 'Group not found or you are not the owner.' });

  // Check if email is already a member
  const existingUser = await User.findOne({ email: String(email).toLowerCase().trim() });
  if (existingUser && group.members.find(m => String(m.user_id) === String(existingUser._id))) {
    return res.status(400).json({ error: 'This person is already in the group.' });
  }

  const token = group.addInvite(email, req.user._id, role === 'viewer' ? 'viewer' : 'member');
  await group.save();

  // Send invite email
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const inviteUrl = `${baseUrl}/account/groups/join/${token}`;
  mailer.sendGroupInvite(email, req.user, group, inviteUrl).catch(() => {});

  res.json({ ok: true });
});

app.delete('/api/account/groups/:id/invites/:inviteId', auth.requireAuth, async (req, res) => {
  const group = await Group.findOne({ _id: req.params.id, owner_id: req.user._id });
  if (!group) return res.status(404).json({ error: 'Not found' });
  const invite = group.invites.id(req.params.inviteId);
  if (invite) invite.revoked_at = new Date();
  await group.save();
  res.json({ ok: true });
});

app.delete('/api/account/groups/:id/members/:memberId', auth.requireAuth, async (req, res) => {
  const group = await Group.findOne({ _id: req.params.id, owner_id: req.user._id });
  if (!group) return res.status(404).json({ error: 'Not found' });
  if (String(req.params.memberId) === String(group.owner_id)) {
    return res.status(400).json({ error: 'Cannot remove the owner. Delete the group instead.' });
  }
  const member = group.members.id(req.params.memberId);
  if (member) member.deleteOne();
  await group.save();
  res.json({ ok: true });
});

// Accept a group invite via email link
app.get('/account/groups/join/:token', async (req, res) => {
  // If not logged in, send to signup with redirect back
  if (!req.user) {
    return res.redirect(`/signup?next=${encodeURIComponent('/account/groups/join/' + req.params.token)}`);
  }
  // Find the group with this invite
  const group = await Group.findOne({ 'invites.token': req.params.token });
  if (!group) {
    return res.render('group-invite-result', {
      title: 'Group invite — FlightDojo',
      success: false,
      message: 'This invitation link is invalid or has expired.'
    });
  }
  const accepted = group.acceptInvite(req.params.token, req.user._id);
  if (!accepted) {
    return res.render('group-invite-result', {
      title: 'Group invite — FlightDojo',
      success: false,
      message: 'This invitation has already been used or has expired.'
    });
  }
  await group.save();
  Notification.push(req.user._id, {
    type: 'account',
    title: `You joined "${group.name}"`,
    body: `You can now view trips shared in this group.`,
    link: `/account/groups/${group._id}`
  }).catch(() => {});
  res.redirect(`/account/groups/${group._id}`);
});

// ═══════════════════════════════════════════════════════════════
// ADMIN PANEL ROUTES
// ═══════════════════════════════════════════════════════════════

// Pages: dashboard / orders / order detail / users / user detail / emails / saved-searches
// All gated by auth.requireAdmin

// ─── ADMIN DASHBOARD ───
app.get('/admin', auth.requireAdmin, async (req, res) => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Bookings count + revenue aggregates
  const [
    awaitingCount,
    todayCount,
    sevenDayCount,
    thirtyDayCount,
    totalUsers,
    newUsersToday,
    recentOrders,
    todayRevenue,
    sevenDayRevenue,
    thirtyDayRevenue,
    refundsLast30,
    emailFailures
  ] = await Promise.all([
    Order.countDocuments({ status: { $in: ['booked', 'paid'] } }),
    Order.countDocuments({ createdAt: { $gte: startOfToday } }),
    Order.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
    Order.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
    User.countDocuments({}),
    User.countDocuments({ createdAt: { $gte: startOfToday } }),
    Order.find({}).sort({ createdAt: -1 }).limit(8).lean(),
    Order.aggregate([
      { $match: { createdAt: { $gte: startOfToday }, status: { $in: ['booked', 'ticketed', 'completed'] } } },
      { $group: { _id: '$total_currency', total: { $sum: { $toDouble: '$total_amount' } } } }
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: sevenDaysAgo }, status: { $in: ['booked', 'ticketed', 'completed'] } } },
      { $group: { _id: '$total_currency', total: { $sum: { $toDouble: '$total_amount' } } } }
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo }, status: { $in: ['booked', 'ticketed', 'completed'] } } },
      { $group: { _id: '$total_currency', total: { $sum: { $toDouble: '$total_amount' } } } }
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo } } },
      { $unwind: '$refunds' },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: { $toDouble: '$refunds.amount' } } } }
    ]),
    EmailLog.recentFailureCount(24).catch(() => 0)
  ]);

  // Top routes (last 30 days)
  const topRoutes = await Order.aggregate([
    { $match: { createdAt: { $gte: thirtyDaysAgo }, 'slices.0': { $exists: true } } },
    { $group: {
      _id: { o: { $arrayElemAt: ['$slices.origin', 0] }, d: { $arrayElemAt: ['$slices.destination', 0] } },
      count: { $sum: 1 }
    }},
    { $sort: { count: -1 } },
    { $limit: 6 }
  ]);

  res.render('admin/dashboard', {
    title: 'Admin · Dashboard — FlightDojo',
    layout_admin: true,
    active_section: 'dashboard',
    stats: {
      awaitingCount,
      todayCount, sevenDayCount, thirtyDayCount,
      totalUsers, newUsersToday,
      todayRevenue, sevenDayRevenue, thirtyDayRevenue,
      refundsLast30: refundsLast30[0] || { count: 0, total: 0 },
      emailFailures
    },
    recentOrders,
    topRoutes
  });
});

// ─── ADMIN ORDERS LIST ───
app.get('/admin/orders', auth.requireAdmin, async (req, res) => {
  const filter = req.query.filter || 'all';
  const search = req.query.q ? String(req.query.q).trim() : '';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = 25;

  const query = {};
  if (filter === 'awaiting') query.status = { $in: ['booked', 'paid'] };
  else if (filter === 'ticketed') query.status = 'ticketed';
  else if (filter === 'completed') query.status = 'completed';
  else if (filter === 'failed') query.status = { $in: ['failed', 'cancelled', 'risk_blocked'] };
  else if (filter === 'refunded') query['refunds.0'] = { $exists: true };

  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [
      { reference: re },
      { booking_reference: re },
      { contact_email: re },
      { contact_phone: re },
      { 'passengers.given_name': re },
      { 'passengers.family_name': re }
    ];
  }

  const [orders, total, counts] = await Promise.all([
    Order.find(query).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Order.countDocuments(query),
    Order.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ])
  ]);

  const countsByStatus = {};
  counts.forEach(c => { countsByStatus[c._id] = c.count; });
  const summary = {
    all: Object.values(countsByStatus).reduce((a, b) => a + b, 0),
    awaiting: (countsByStatus.booked || 0) + (countsByStatus.paid || 0),
    ticketed: countsByStatus.ticketed || 0,
    completed: countsByStatus.completed || 0,
    failed: (countsByStatus.failed || 0) + (countsByStatus.cancelled || 0) + (countsByStatus.risk_blocked || 0)
  };

  res.render('admin/orders', {
    title: 'Admin · Orders — FlightDojo',
    layout_admin: true,
    active_section: 'orders',
    orders,
    filter,
    search,
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
    summary
  });
});

// ─── ADMIN ORDER DETAIL ───
app.get('/admin/orders/:reference', auth.requireAdmin, async (req, res) => {
  const order = await Order.findOne({ reference: req.params.reference })
    .populate('user_id', 'email name phone createdAt')
    .populate('group_id', 'name icon')
    .lean();
  if (!order) return res.status(404).render('404', { title: '404 — FlightDojo' });

  // Email history for this order
  const emails = await EmailLog.find({ order_reference: order.reference })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  res.render('admin/order-detail', {
    title: `Admin · ${order.reference} — FlightDojo`,
    layout_admin: true,
    active_section: 'orders',
    order,
    emails,
    stripe_dashboard_url: process.env.STRIPE_DASHBOARD_URL || 'https://dashboard.stripe.com/test/payments'
  });
});

// ─── ADMIN ACTIONS ON ORDERS ───

// Mark ticketed: customer's PNR is now known. Updates order, pushes notification,
// sends "your ticket is ready" email.
app.post('/api/admin/orders/:reference/ticket', auth.requireAdmin, async (req, res) => {
  const order = await Order.findOne({ reference: req.params.reference });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { pnr, note } = req.body || {};
  if (!pnr || !/^[A-Z0-9]{5,8}$/i.test(String(pnr).trim())) {
    return res.status(400).json({ error: 'PNR is required (5-8 alphanumeric characters).' });
  }

  const cleanPnr = String(pnr).trim().toUpperCase();
  order.booking_reference = cleanPnr;
  order.status = 'ticketed';
  order.ticketed_at = new Date();
  order.ticketed_by_user_id = req.user._id;
  order.ticketed_by_email = req.user.email;
  order.audit_log.push({
    action: 'marked_ticketed',
    actor_user_id: req.user._id,
    actor_email: req.user.email,
    payload: { pnr: cleanPnr, note: note || null }
  });
  if (note) {
    order.internal_notes.push({
      text: `Ticketed with PNR ${cleanPnr}. ${note}`,
      author_user_id: req.user._id,
      author_email: req.user.email
    });
  }
  await order.save();

  // Send email
  mailer.sendTicketIssued(order.toObject(), cleanPnr).catch(() => {});

  // Push notification if user is linked
  if (order.user_id) {
    const route = order.slices?.[0] ? `${order.slices[0].origin} → ${order.slices[order.slices.length-1].destination}` : 'your trip';
    Notification.push(order.user_id, {
      type: 'ticket_issued',
      title: `Ticket ready · ${route}`,
      body: `Your airline reference is ${cleanPnr}. Check-in opens 24h before departure.`,
      link: `/account/bookings/${order.reference}`,
      order_reference: order.reference
    }).catch(() => {});
  }

  res.json({ ok: true });
});

// Mark completed (trip has been taken / closed out)
app.post('/api/admin/orders/:reference/complete', auth.requireAdmin, async (req, res) => {
  const order = await Order.findOne({ reference: req.params.reference });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.status = 'completed';
  order.completed_at = new Date();
  order.audit_log.push({
    action: 'marked_completed',
    actor_user_id: req.user._id,
    actor_email: req.user.email
  });
  await order.save();
  res.json({ ok: true });
});

// Mark cancelled (without refund — e.g. customer no-show, or refund happened externally)
app.post('/api/admin/orders/:reference/cancel', auth.requireAdmin, async (req, res) => {
  const { reason } = req.body || {};
  const order = await Order.findOne({ reference: req.params.reference });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.status = 'cancelled';
  order.audit_log.push({
    action: 'marked_cancelled',
    actor_user_id: req.user._id,
    actor_email: req.user.email,
    payload: { reason: reason || null }
  });
  if (reason) {
    order.internal_notes.push({
      text: `Cancelled. ${reason}`,
      author_user_id: req.user._id,
      author_email: req.user.email
    });
  }
  await order.save();
  res.json({ ok: true });
});

// Issue refund (via Stripe API)
app.post('/api/admin/orders/:reference/refund', auth.requireAdmin, async (req, res) => {
  const { amount, reason, notes, confirm_ref } = req.body || {};
  const order = await Order.findOne({ reference: req.params.reference });
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // Type-the-ref-to-confirm safety
  if (confirm_ref !== order.reference) {
    return res.status(400).json({ error: 'Type the order reference exactly to confirm.' });
  }
  if (!order.stripe_payment_intent_id) {
    return res.status(400).json({ error: 'No Stripe PaymentIntent recorded on this order. Refund manually in Stripe dashboard.' });
  }

  const refundAmount = amount && parseFloat(amount) > 0 ? parseFloat(amount) : parseFloat(order.total_amount);
  const alreadyRefunded = parseFloat(order.total_refunded || '0');
  if (alreadyRefunded + refundAmount > parseFloat(order.total_amount) + 0.01) {
    return res.status(400).json({ error: `Refund exceeds order total. Already refunded: ${order.total_currency} ${alreadyRefunded}, order total: ${order.total_currency} ${order.total_amount}` });
  }

  const result = await stripeService.refundPaymentIntent(
    order.stripe_payment_intent_id,
    refundAmount,
    reason || 'requested_by_customer'
  );
  if (!result.ok) return res.status(500).json({ error: result.error });

  order.refunds.push({
    stripe_refund_id: result.refund_id,
    amount: refundAmount.toFixed(2),
    currency: order.total_currency,
    reason: reason || 'requested_by_customer',
    notes: notes || '',
    status: result.status,
    issued_by_user_id: req.user._id,
    issued_by_email: req.user.email
  });
  order.total_refunded = (alreadyRefunded + refundAmount).toFixed(2);
  order.audit_log.push({
    action: 'refund_issued',
    actor_user_id: req.user._id,
    actor_email: req.user.email,
    payload: {
      stripe_refund_id: result.refund_id,
      amount: refundAmount.toFixed(2),
      currency: order.total_currency,
      reason: reason || null
    }
  });
  // If fully refunded, mark cancelled
  if (Math.abs(parseFloat(order.total_refunded) - parseFloat(order.total_amount)) < 0.01) {
    order.status = 'cancelled';
  }
  await order.save();

  // Notify customer + send refund email
  mailer.sendRefundIssued(order.toObject(), {
    amount: refundAmount.toFixed(2),
    currency: order.total_currency,
    reason: reason || null,
    notes: notes || null
  }).catch(() => {});

  if (order.user_id) {
    Notification.push(order.user_id, {
      type: 'payment_received',
      title: `Refund issued · ${order.total_currency} ${refundAmount.toFixed(2)}`,
      body: `We've refunded ${order.total_currency} ${refundAmount.toFixed(2)} for order ${order.reference}. It should appear in your account within 5-10 business days.`,
      link: `/account/bookings/${order.reference}`,
      order_reference: order.reference
    }).catch(() => {});
  }

  res.json({ ok: true, refund: result });
});

// Add internal note (ops-only, never shown to customer)
app.post('/api/admin/orders/:reference/notes', auth.requireAdmin, async (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Note text required.' });
  const order = await Order.findOne({ reference: req.params.reference });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.internal_notes.push({
    text: String(text).trim().slice(0, 2000),
    author_user_id: req.user._id,
    author_email: req.user.email
  });
  order.audit_log.push({
    action: 'note_added',
    actor_user_id: req.user._id,
    actor_email: req.user.email
  });
  await order.save();
  res.json({ ok: true });
});

// Send custom email to customer
app.post('/api/admin/orders/:reference/email', auth.requireAdmin, async (req, res) => {
  const { subject, message } = req.body || {};
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message required.' });
  const order = await Order.findOne({ reference: req.params.reference });
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const result = await mailer.sendCustomAdmin({
    to: order.contact_email,
    subject: String(subject).slice(0, 200),
    message: String(message).slice(0, 5000),
    order_reference: order.reference,
    user_id: order.user_id || null
  });

  order.audit_log.push({
    action: 'email_sent',
    actor_user_id: req.user._id,
    actor_email: req.user.email,
    payload: { subject, success: result.ok }
  });
  await order.save();

  res.json(result);
});

// Resend an existing email
app.post('/api/admin/emails/:id/resend', auth.requireAdmin, async (req, res) => {
  const result = await mailer.resendByLogId(req.params.id, req.user);
  res.json(result);
});

// ─── ADMIN USERS LIST ───
app.get('/admin/users', auth.requireAdmin, async (req, res) => {
  const search = req.query.q ? String(req.query.q).trim() : '';
  const sort = req.query.sort || 'recent';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = 30;

  const query = {};
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ email: re }, { name: re }, { phone: re }];
  }

  const sortMap = {
    recent: { createdAt: -1 },
    oldest: { createdAt: 1 },
    name: { name: 1 },
    last_login: { last_login_at: -1 }
  };

  const users = await User.find(query)
    .select('email name phone createdAt last_login_at login_count is_admin admin_role referrals_count')
    .sort(sortMap[sort] || sortMap.recent)
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .lean();

  // For each user, compute order count + total spend (efficient via aggregation)
  const userIds = users.map(u => u._id);
  const stats = await Order.aggregate([
    { $match: { user_id: { $in: userIds }, status: { $in: ['booked', 'ticketed', 'completed'] } } },
    { $group: {
      _id: '$user_id',
      orders: { $sum: 1 },
      spend: { $sum: { $toDouble: '$total_amount' } }
    }}
  ]);
  const statsByUser = {};
  stats.forEach(s => { statsByUser[String(s._id)] = s; });
  users.forEach(u => {
    const s = statsByUser[String(u._id)];
    u.orders_count = s?.orders || 0;
    u.total_spend = s?.spend || 0;
  });

  const total = await User.countDocuments(query);

  res.render('admin/users', {
    title: 'Admin · Users — FlightDojo',
    layout_admin: true,
    active_section: 'users',
    users,
    search,
    sort,
    page,
    total,
    totalPages: Math.ceil(total / pageSize)
  });
});

// ─── ADMIN USER DETAIL ───
app.get('/admin/users/:id', auth.requireAdmin, async (req, res) => {
  let user;
  try {
    user = await User.findById(req.params.id).lean();
  } catch (e) {
    return res.status(404).render('404', { title: '404 — FlightDojo' });
  }
  if (!user) return res.status(404).render('404', { title: '404 — FlightDojo' });

  const [orders, emails, notifications] = await Promise.all([
    Order.find({ user_id: user._id }).sort({ createdAt: -1 }).limit(50).lean(),
    EmailLog.find({ $or: [{ user_id: user._id }, { to: user.email }] }).sort({ createdAt: -1 }).limit(30).lean(),
    Notification.find({ user_id: user._id }).sort({ createdAt: -1 }).limit(20).lean()
  ]);

  const totalSpend = orders
    .filter(o => ['booked', 'ticketed', 'completed'].includes(o.status))
    .reduce((sum, o) => sum + parseFloat(o.total_amount || 0), 0);

  res.render('admin/user-detail', {
    title: `Admin · ${user.email} — FlightDojo`,
    layout_admin: true,
    active_section: 'users',
    target_user: user,
    orders,
    emails,
    notifications,
    total_spend: totalSpend,
    is_self: String(user._id) === String(req.user._id)
  });
});

// Trigger password reset for a user (admin action — generates link, emails it)
app.post('/api/admin/users/:id/trigger-reset', auth.requireAdmin, async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const result = await auth.startPasswordReset({ email: user.email });
  if (result.token && result.user) {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const linkUrl = `${baseUrl}/account/reset/${result.token}`;
    mailer.sendPasswordReset(result.user, linkUrl).catch(() => {});
  }
  res.json({ ok: true });
});

// ─── ADMIN EMAILS LOG ───
app.get('/admin/emails', auth.requireAdmin, async (req, res) => {
  const status = req.query.status || 'all';
  const search = req.query.q ? String(req.query.q).trim() : '';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = 50;

  const query = {};
  if (status && status !== 'all') query.status = status;
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ to: re }, { subject: re }, { order_reference: re }];
  }

  const [emails, total, counts] = await Promise.all([
    EmailLog.find(query).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    EmailLog.countDocuments(query),
    EmailLog.aggregate([{ $group: { _id: '$status', c: { $sum: 1 } } }])
  ]);

  const summary = {};
  counts.forEach(c => { summary[c._id] = c.c; });

  res.render('admin/emails', {
    title: 'Admin · Emails — FlightDojo',
    layout_admin: true,
    active_section: 'emails',
    emails,
    status,
    search,
    page,
    total,
    totalPages: Math.ceil(total / pageSize),
    summary
  });
});

// ─── ADMIN CODE SNIPPETS ────────────────────────────────────
// Header/footer code injection. Writes restricted to owner + manager.

function canWriteSnippets(user) {
  return !!(user && user.is_admin && (user.admin_role === 'owner' || user.admin_role === 'manager'));
}

function validateSnippetPayload(body) {
  const errors = {};
  const name = String(body.name || '').trim();
  if (!name) errors.name = 'Name is required.';
  if (name.length > 120) errors.name = 'Name is too long (max 120 chars).';
  const placement = String(body.placement || '').trim();
  if (!['header', 'footer'].includes(placement)) errors.placement = 'Placement must be "header" or "footer".';
  const scope = String(body.scope || 'all').trim();
  if (!['all', 'internal', 'external'].includes(scope)) errors.scope = 'Scope must be "all", "internal", or "external".';
  const code = String(body.code || '');
  if (!code.trim()) errors.code = 'Code body is required.';
  if (code.length > 65536) errors.code = 'Code is too large (max 64 KB).';
  function normalizePaths(input) {
    if (!input) return [];
    const arr = Array.isArray(input) ? input : String(input).split(/[\n,]/);
    return arr.map(s => String(s).trim()).filter(Boolean).filter(p => p.length <= 200).slice(0, 50);
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    payload: {
      name,
      description: String(body.description || '').trim().slice(0, 500),
      placement, scope, code,
      active: body.active !== false && body.active !== 'false' && body.active !== '0',
      priority: Number.isFinite(parseInt(body.priority, 10)) ? parseInt(body.priority, 10) : 100,
      include_paths: normalizePaths(body.include_paths),
      exclude_paths: normalizePaths(body.exclude_paths),
      note: String(body.note || '').trim().slice(0, 500)
    }
  };
}

function requireSnippetWriter(req, res, next) {
  if (!canWriteSnippets(req.user)) {
    return req.path.startsWith('/api/')
      ? res.status(403).json({ error: 'requires_role', message: 'Owner or manager role required.' })
      : res.status(403).render('404', { title: 'Forbidden — FlightDojo' });
  }
  next();
}

app.get('/admin/snippets', auth.requireAdmin, async (req, res) => {
  const snippets = await CodeSnippet.find({}).sort({ placement: 1, priority: 1, createdAt: 1 }).lean();
  res.render('admin/snippets/index', {
    title: 'Admin · Code Snippets — FlightDojo', layout_admin: true,
    active_section: 'snippets', snippets, can_write: canWriteSnippets(req.user)
  });
});

app.get('/admin/snippets/new', auth.requireAdmin, requireSnippetWriter, (req, res) => {
  res.render('admin/snippets/edit', {
    title: 'Admin · New Snippet — FlightDojo', layout_admin: true,
    active_section: 'snippets', snippet: null
  });
});

app.get('/admin/snippets/:id/edit', auth.requireAdmin, requireSnippetWriter, async (req, res) => {
  const snippet = await CodeSnippet.findById(req.params.id).lean();
  if (!snippet) return res.status(404).render('404', { title: 'Not found' });
  res.render('admin/snippets/edit', {
    title: `Admin · Edit ${snippet.name} — FlightDojo`, layout_admin: true,
    active_section: 'snippets', snippet
  });
});

app.get('/admin/snippets/:id/revisions', auth.requireAdmin, async (req, res) => {
  const snippet = await CodeSnippet.findById(req.params.id).lean();
  if (!snippet) return res.status(404).render('404', { title: 'Not found' });
  res.render('admin/snippets/revisions', {
    title: `Admin · History · ${snippet.name} — FlightDojo`, layout_admin: true,
    active_section: 'snippets', snippet
  });
});

app.get('/api/admin/snippets', auth.requireAdmin, async (req, res) => {
  const snippets = await CodeSnippet.find({}).sort({ placement: 1, priority: 1, createdAt: 1 }).lean();
  res.json({ snippets });
});

app.get('/api/admin/snippets/_preview', auth.requireAdmin, async (req, res) => {
  const path = String(req.query.path || '/');
  res.json(await codeSnippets.renderForPath(path));
});

app.get('/api/admin/snippets/:id', auth.requireAdmin, async (req, res) => {
  const snippet = await CodeSnippet.findById(req.params.id).lean();
  if (!snippet) return res.status(404).json({ error: 'not_found' });
  res.json({ snippet });
});

app.post('/api/admin/snippets', auth.requireAdmin, requireSnippetWriter, async (req, res) => {
  const { ok, errors, payload } = validateSnippetPayload(req.body);
  if (!ok) return res.status(400).json({ error: 'validation', errors });
  const existing = await CodeSnippet.findOne({ name: payload.name });
  if (existing) return res.status(409).json({ error: 'validation', errors: { name: 'A snippet with this name already exists.' } });
  try {
    const doc = new CodeSnippet({
      ...payload, created_by_user_id: req.user._id, created_by_email: req.user.email,
      last_edited_by_user_id: req.user._id, last_edited_by_email: req.user.email
    });
    doc.recordRevision(req.user, payload.note || 'Created');
    await doc.save();
    codeSnippets.invalidateCache();
    res.status(201).json({ snippet: doc.toObject() });
  } catch (err) { console.error('Create snippet failed:', err); res.status(500).json({ error: 'server_error', message: err.message }); }
});

app.put('/api/admin/snippets/:id', auth.requireAdmin, requireSnippetWriter, async (req, res) => {
  const { ok, errors, payload } = validateSnippetPayload(req.body);
  if (!ok) return res.status(400).json({ error: 'validation', errors });
  const doc = await CodeSnippet.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  if (payload.name !== doc.name) {
    const clash = await CodeSnippet.findOne({ name: payload.name, _id: { $ne: doc._id } });
    if (clash) return res.status(409).json({ error: 'validation', errors: { name: 'A snippet with this name already exists.' } });
  }
  if (doc.code !== payload.code) doc.recordRevision(req.user, payload.note || 'Edited');
  Object.assign(doc, { name: payload.name, description: payload.description, placement: payload.placement,
    scope: payload.scope, code: payload.code, active: payload.active, priority: payload.priority,
    include_paths: payload.include_paths, exclude_paths: payload.exclude_paths,
    last_edited_by_user_id: req.user._id, last_edited_by_email: req.user.email });
  try { await doc.save(); codeSnippets.invalidateCache(); res.json({ snippet: doc.toObject() }); }
  catch (err) { console.error('Update snippet failed:', err); res.status(500).json({ error: 'server_error', message: err.message }); }
});

app.post('/api/admin/snippets/:id/toggle', auth.requireAdmin, requireSnippetWriter, async (req, res) => {
  const doc = await CodeSnippet.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  doc.active = !doc.active;
  doc.last_edited_by_user_id = req.user._id;
  doc.last_edited_by_email = req.user.email;
  await doc.save(); codeSnippets.invalidateCache();
  res.json({ snippet: { _id: doc._id, active: doc.active } });
});

app.post('/api/admin/snippets/:id/restore/:revisionIndex', auth.requireAdmin, requireSnippetWriter, async (req, res) => {
  const doc = await CodeSnippet.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  const idx = parseInt(req.params.revisionIndex, 10);
  if (!Number.isFinite(idx) || idx < 0 || idx >= doc.revisions.length) return res.status(400).json({ error: 'invalid_revision_index' });
  doc.recordRevision(req.user, `Restored revision ${idx}`);
  doc.code = doc.revisions[idx].code;
  doc.last_edited_by_user_id = req.user._id;
  doc.last_edited_by_email = req.user.email;
  await doc.save(); codeSnippets.invalidateCache();
  res.json({ snippet: doc.toObject() });
});

app.delete('/api/admin/snippets/:id', auth.requireAdmin, requireSnippetWriter, async (req, res) => {
  const doc = await CodeSnippet.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  await doc.deleteOne(); codeSnippets.invalidateCache();
  res.json({ ok: true, deleted: doc._id });
});

// ─── STATIC PAGES ────────────────────────────────────────
// ─── SEO INFRASTRUCTURE ─────────────────────────────────────

// robots.txt — tells crawlers where they're welcome (and where they're not)
app.get('/robots.txt', (req, res) => {
  const baseUrl = (process.env.BASE_URL || 'https://flightdojo.it.com').replace(/\/+$/, '');
  res.type('text/plain').send(
`User-agent: *
Allow: /
Disallow: /account
Disallow: /admin
Disallow: /api
Disallow: /booking
Disallow: /offer
Disallow: /search
Disallow: /login
Disallow: /signup
Disallow: /forgot
Disallow: /reset
Disallow: /webhooks

# AI scrapers — block from training on our content
User-agent: GPTBot
Disallow: /
User-agent: ClaudeBot
Disallow: /
User-agent: anthropic-ai
Disallow: /
User-agent: CCBot
Disallow: /
User-agent: Google-Extended
Disallow: /

Sitemap: ${baseUrl}/sitemap.xml
`);
});

// sitemap.xml — list of every public, indexable URL
app.get('/sitemap.xml', (req, res) => {
  const baseUrl = (process.env.BASE_URL || 'https://flightdojo.it.com').replace(/\/+$/, '');
  const urls = [
    { loc: baseUrl + '/', priority: 1.0, changefreq: 'daily' },
    { loc: baseUrl + '/about', priority: 0.7, changefreq: 'monthly' },
    { loc: baseUrl + '/contact', priority: 0.8, changefreq: 'monthly' },
    { loc: baseUrl + '/careers', priority: 0.5, changefreq: 'weekly' },
    { loc: baseUrl + '/privacy-policy', priority: 0.3, changefreq: 'yearly' },
    { loc: baseUrl + '/terms', priority: 0.3, changefreq: 'yearly' },
    { loc: baseUrl + '/refund-policy', priority: 0.3, changefreq: 'yearly' },
    { loc: baseUrl + '/disclaimer', priority: 0.3, changefreq: 'yearly' }
  ];
  const lastmod = new Date().toISOString().split('T')[0];
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u =>
      `  <url>\n` +
      `    <loc>${u.loc}</loc>\n` +
      `    <lastmod>${lastmod}</lastmod>\n` +
      `    <changefreq>${u.changefreq}</changefreq>\n` +
      `    <priority>${u.priority}</priority>\n` +
      `  </url>`
    ).join('\n') +
    '\n</urlset>\n';
  res.type('application/xml').send(body);
});

// Web app manifest — for "Add to home screen" + PWA-lite behavior
app.get('/site.webmanifest', (req, res) => {
  res.type('application/manifest+json').send({
    name: 'FlightDojo',
    short_name: 'FlightDojo',
    description: 'Precision flight booking with zero hidden fees.',
    start_url: '/',
    display: 'standalone',
    background_color: '#fafaf7',
    theme_color: '#FF5038',
    icons: [
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }
    ]
  });
});

app.get('/about', (req, res) => res.render('about', {
  title: 'About FlightDojo — Precision flight booking',
  seo: { ...res.locals.seo, title: 'About FlightDojo — Precision flight booking', description: 'FlightDojo is a precision flight-booking platform from Lazarus Consulting LLC, built for travellers who value clarity over noise. Real fares, zero hidden fees, 24/7 human support.' }
}));
app.get('/careers', (req, res) => res.render('careers', {
  title: 'Careers — FlightDojo',
  seo: { ...res.locals.seo, title: 'Careers — FlightDojo', description: 'Join the FlightDojo team. Engineering, operations, customer success roles for builders who want to reshape how the world books travel.' }
}));
app.get('/contact', (req, res) => res.render('contact', {
  title: 'Contact FlightDojo — 24/7 support',
  seo: { ...res.locals.seo, title: 'Contact FlightDojo — 24/7 support', description: 'Reach FlightDojo support 24/7. Phone, email, and live ticket assistance for bookings, changes, refunds, and travel emergencies.' },
  sent: false
}));
app.post('/contact', (req, res) => {
  res.render('contact', { title: 'Contact — FlightDojo', sent: true, seo: { ...res.locals.seo, title: 'Contact FlightDojo' } });
});
app.get('/privacy-policy', (req, res) => res.render('privacy-policy', {
  title: 'Privacy Policy — FlightDojo',
  seo: { ...res.locals.seo, title: 'Privacy Policy — FlightDojo', description: 'How FlightDojo collects, uses, and protects your personal information when you search and book flights through our platform.' }
}));
app.get('/disclaimer', (req, res) => res.render('disclaimer', {
  title: 'Disclaimer — FlightDojo',
  seo: { ...res.locals.seo, title: 'Disclaimer — FlightDojo', description: 'Legal disclaimer covering FlightDojo\'s role as an intermediary booking service, limitations of liability, and airline relationships.' }
}));
app.get('/refund-policy', (req, res) => res.render('refund-policy', {
  title: 'Refund Policy — FlightDojo',
  seo: { ...res.locals.seo, title: 'Refund Policy — FlightDojo', description: 'FlightDojo refund terms: airline-driven cancellations, schedule changes, customer cancellations, and processing times.' }
}));
app.get('/terms', (req, res) => res.render('terms', {
  title: 'Terms of Service — FlightDojo',
  seo: { ...res.locals.seo, title: 'Terms of Service — FlightDojo', description: 'Terms and conditions governing your use of FlightDojo. Booking conditions, payment, cancellation, and liability.' }
}));
app.post('/contact', (req, res) => {
  console.log('Contact:', req.body);
  res.render('contact', { title: 'Contact — FlightDojo', sent: true, seo: { ...res.locals.seo, title: 'Contact FlightDojo' } });
});

app.use((req, res) => res.status(404).render('404', { title: '404 — FlightDojo', seo: { ...res.locals.seo, title: 'Page not found — FlightDojo', noindex: true } }));

app.listen(PORT, () => {
  console.log(`FlightDojo running on http://localhost:${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Duffel: ${process.env.DUFFEL_ACCESS_TOKEN && !process.env.DUFFEL_ACCESS_TOKEN.includes('REPLACE_ME') ? 'LIVE' : 'MOCK'}`);
  console.log(`Stripe: ${stripeService.hasRealKey ? 'LIVE' : 'MOCK'}`);
  console.log(`ProxyCheck: ${process.env.PROXYCHECK_API_KEY ? 'ENABLED' : 'PERMISSIVE (no key)'}`);

  // Start background jobs
  try {
    const cronService = require('./services/cron');
    cronService.startCron();
  } catch (err) {
    console.warn('⚠  Cron not started:', err.message);
  }

  // ─── Admin bootstrap from .env ───
  // ADMIN_EMAIL: comma-separated list. Every user matching one of these gets is_admin=true.
  // ADMIN_PASSWORD: if set, also creates the first admin user (only when missing).
  //   Subsequent boots leave the existing password alone.
  bootstrapAdminFromEnv().catch(err => console.warn('⚠  Admin bootstrap failed:', err.message));
});

async function bootstrapAdminFromEnv() {
  const adminEmails = (process.env.ADMIN_EMAIL || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.length === 0) return;

  const adminPassword = process.env.ADMIN_PASSWORD || '';
  let promoted = 0, created = 0;

  for (const email of adminEmails) {
    let user = await User.findOne({ email });

    if (!user && adminPassword) {
      // Create the admin user since they don't exist
      if (adminPassword.length < 8) {
        console.warn(`⚠  ADMIN_PASSWORD must be 8+ chars — skipping creation of ${email}`);
        continue;
      }
      user = new User({ email, name: 'Admin' });
      await user.setPassword(adminPassword);
      user.email_verified_at = new Date();
      user.is_admin = true;
      user.admin_role = 'owner';
      await user.save();
      created++;
      console.log(`🔑 Created admin user from .env: ${email}`);
      continue;
    }

    if (!user) {
      console.log(`⚠  ADMIN_EMAIL ${email} has no account yet — set ADMIN_PASSWORD to auto-create, or sign up manually and reboot.`);
      continue;
    }

    // Promote existing user
    if (!user.is_admin || user.admin_role !== 'owner') {
      user.is_admin = true;
      user.admin_role = 'owner';
      await user.save();
      promoted++;
      console.log(`🔑 Promoted to admin: ${email}`);
    }
  }

  if (promoted > 0 || created > 0) {
    console.log(`🔑 Admin bootstrap: ${created} created, ${promoted} promoted, ${adminEmails.length} configured`);
  } else {
    console.log(`🔑 Admin bootstrap: ${adminEmails.length} configured, all already set up`);
  }
}

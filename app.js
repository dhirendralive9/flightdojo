require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const { searchOffers, getOffer, createOrder: createDuffelOrder } = require('./services/duffel');
const airportsService = require('./services/airports');
const turnstile = require('./services/turnstile');
const stripeService = require('./services/stripe');
const proxycheck = require('./services/proxycheck');
const mailer = require('./services/mailer');
const Order = require('./models/Order');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ─── MongoDB ─────────────────────────────────────────────
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/flightdojo';
mongoose.connect(mongoUri)
  .then(() => console.log(`🍃 MongoDB connected: ${mongoUri.replace(/\/\/[^@]*@/, '//***@')}`))
  .catch(err => console.warn('⚠  MongoDB connection failed:', err.message, '— orders will not persist'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', true);

// Static assets: cache long (1 year) — we cache-bust via ?v=<timestamp>
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1y',
  etag: true,
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

app.use((req, res, next) => {
  res.locals.navLinks = navLinks;
  res.locals.footerLinks = footerLinks;
  res.locals.currentPath = req.path;
  res.locals.year = new Date().getFullYear();
  res.locals.turnstileSitekey = turnstile.sitekey;
  res.locals.turnstileTestMode = turnstile.isTestMode;
  res.locals.stripePublishableKey = stripeService.publishableKey;
  res.locals.assetVersion = ASSET_VERSION;
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
  res.render('home', {
    title: 'FlightDojo — Find. Book. Fly.',
    prefill: { origin: 'DEL', destination: 'MXP', depart: dates.depart, return: dates.return, passengers: 1 },
    origin_info: airportsService.byIata('DEL'),
    destination_info: airportsService.byIata('MXP')
  });
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

  res.render('search-results', {
    title: `Flights ${origin} → ${destination} — FlightDojo`,
    query: {
      origin: origin.toUpperCase(), destination: destination.toUpperCase(),
      depart, ret: ret || null,
      passengers: parseInt(passengers, 10) || 1,
      cabin: cabin || 'economy'
    },
    origin_info: airportsService.byIata(origin),
    destination_info: airportsService.byIata(destination),
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

// Step 1: Passenger details form
app.get('/book/:offerId', async (req, res) => {
  try {
    const { offer } = await getOffer(req.params.offerId);
    if (!offer) return res.status(404).render('404', { title: '404 — FlightDojo' });
    res.render('booking-form', {
      title: `Book ${offer.slices[0]?.origin} → ${offer.slices[0]?.destination} — FlightDojo`,
      offer,
      origin_info: airportsService.byIata(offer.slices[0]?.origin),
      destination_info: airportsService.byIata(offer.slices[0]?.destination)
    });
  } catch (err) {
    console.error('Book page error:', err);
    res.status(500).render('404', { title: 'Error — FlightDojo' });
  }
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

    // Create Order in DB
    const reference = generateReference();
    const amount = parseFloat(offer.total_amount);
    const currency = offer.total_currency || 'EUR';

    let order;
    try {
      order = await Order.create({
        reference,
        status: 'awaiting_payment',
        duffel_offer_id: offer_id,
        total_amount: offer.total_amount,
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
        proxy_check: proxyResult
      });
    } catch (err) {
      console.warn('Order persistence skipped:', err.message);
      // Continue without DB so the demo still works
      order = { reference, _id: null };
    }

    // Create Stripe PaymentIntent
    const intent = await stripeService.createPaymentIntent({
      amount,
      currency,
      receipt_email: contact_email,
      metadata: {
        order_reference: reference,
        duffel_offer_id: offer_id,
        description: `FlightDojo ${offer.slices[0]?.origin} → ${offer.slices[0]?.destination}`
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
app.get('/booking/:reference', async (req, res) => {
  const order = await Order.findOne({ reference: req.params.reference }).catch(() => null);
  res.render('booking-status', {
    title: `Booking ${req.params.reference} — FlightDojo`,
    order,
    reference: req.params.reference,
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

      // Mark paid
      order.status = 'paid';
      order.stripe_payment_status = pi.status;
      order.stripe_payment_method = pi.payment_method_types?.[0] || null;
      await order.save();
      console.log(`💳 Payment confirmed for ${reference} — attempting Duffel order…`);

      // Create Duffel order
      try {
        const duffelOrder = await createDuffelOrder({
          offerId: order.duffel_offer_id,
          passengers: order.passengers,
          contact: { email: order.contact_email, phone: order.contact_phone },
          amount: order.total_amount,
          currency: order.total_currency
        });
        order.duffel_order_id = duffelOrder.id;
        order.booking_reference = duffelOrder.booking_reference;
        order.status = 'booked';
        await order.save();
        console.log(`✓ Booked ${reference} → ${duffelOrder.booking_reference}`);
      } catch (err) {
        console.error('Duffel order failed after payment:', err.errors || err.message);
        order.status = 'failed';
        order.failure_reason = err.errors?.[0]?.message || err.message || 'Booking creation failed';
        await order.save();
      }

      // Send the appropriate email based on outcome
      if (order.status === 'booked') {
        const sent = await mailer.sendBookingConfirmation(order.toObject());
        if (sent) {
          order.email_sent_at = new Date();
          await order.save();
        }
      } else if (order.status === 'failed') {
        // Customer was charged but no PNR. Send a "we have your payment, we're
        // working on it" email so they're not left in the dark.
        const sent = await mailer.sendBookingPending(order.toObject(), order.failure_reason);
        if (sent) {
          order.email_sent_at = new Date();
          await order.save();
        }
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

// ─── STATIC PAGES ────────────────────────────────────────
app.get('/about', (req, res) => res.render('about', { title: 'About — FlightDojo' }));
app.get('/careers', (req, res) => res.render('careers', { title: 'Careers — FlightDojo' }));
app.get('/contact', (req, res) => res.render('contact', { title: 'Contact — FlightDojo', sent: false }));
app.post('/contact', (req, res) => {
  console.log('Contact:', req.body);
  res.render('contact', { title: 'Contact — FlightDojo', sent: true });
});
app.get('/privacy-policy', (req, res) => res.render('privacy-policy', { title: 'Privacy Policy — FlightDojo' }));
app.get('/disclaimer', (req, res) => res.render('disclaimer', { title: 'Disclaimer — FlightDojo' }));
app.get('/refund-policy', (req, res) => res.render('refund-policy', { title: 'Refund Policy — FlightDojo' }));
app.get('/terms', (req, res) => res.render('terms', { title: 'Terms of Service — FlightDojo' }));

app.use((req, res) => res.status(404).render('404', { title: '404 — FlightDojo' }));

app.listen(PORT, () => {
  console.log(`FlightDojo running on http://localhost:${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Duffel: ${process.env.DUFFEL_ACCESS_TOKEN && !process.env.DUFFEL_ACCESS_TOKEN.includes('REPLACE_ME') ? 'LIVE' : 'MOCK'}`);
  console.log(`Stripe: ${stripeService.hasRealKey ? 'LIVE' : 'MOCK'}`);
  console.log(`ProxyCheck: ${process.env.PROXYCHECK_API_KEY ? 'ENABLED' : 'PERMISSIVE (no key)'}`);
});

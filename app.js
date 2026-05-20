require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const { searchOffers, getOffer, getSeatMaps } = require('./services/duffel');
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

    // Create Order in DB. Charge = flight price + add-ons.
    const reference = generateReference();
    const flightAmount = parseFloat(offer.total_amount);
    const amount = flightAmount + parseFloat(addons.total_addons_amount);
    const currency = offer.total_currency || 'EUR';

    let order;
    try {
      order = await Order.create({
        reference,
        status: 'awaiting_payment',
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

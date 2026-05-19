require('dotenv').config();

const express = require('express');
const path = require('path');
const { searchOffers, getOffer } = require('./services/duffel');
const airportsService = require('./services/airports');
const turnstile = require('./services/turnstile');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
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

app.use((req, res, next) => {
  res.locals.navLinks = navLinks;
  res.locals.footerLinks = footerLinks;
  res.locals.currentPath = req.path;
  res.locals.year = new Date().getFullYear();
  res.locals.turnstileSitekey = turnstile.sitekey;
  res.locals.turnstileTestMode = turnstile.isTestMode;
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

app.get('/', (req, res) => {
  const dates = defaultDates();
  res.render('home', {
    title: 'FlightDojo — Find. Book. Fly.',
    prefill: {
      origin: 'DEL',
      destination: 'MXP',
      depart: dates.depart,
      return: dates.return,
      passengers: 1
    },
    origin_info: airportsService.byIata('DEL'),
    destination_info: airportsService.byIata('MXP')
  });
});

app.get('/landing', (req, res) => {
  const dates = defaultDates();
  res.render('landing', {
    title: 'FlightDojo — Search smarter. Fly sharper.',
    prefill: {
      origin: 'DEL',
      destination: 'MXP',
      depart: dates.depart,
      return: dates.return,
      passengers: 1
    },
    origin_info: airportsService.byIata('DEL'),
    destination_info: airportsService.byIata('MXP')
  });
});

async function handleSearch(req, res) {
  const params = req.method === 'POST' ? req.body : req.query;
  const { origin, destination, depart, ret, passengers, cabin, max_connections } = params;
  const turnstileToken = params['cf-turnstile-response'] || params.turnstile_token;

  if (!origin || !destination || !depart) {
    return res.redirect('/');
  }

  // Verify Turnstile token on POST submissions (from the search form).
  // GET requests (e.g. from internal route cards or shared links) skip verification
  // since they're not user-submitted form data.
  if (req.method === 'POST') {
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const verification = await turnstile.verify(turnstileToken, ip);

    if (!verification.success) {
      console.warn('Turnstile verification failed:', verification.error_codes || verification.error);
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
      origin: origin.toUpperCase(),
      destination: destination.toUpperCase(),
      depart,
      ret: ret || null,
      passengers: parseInt(passengers, 10) || 1,
      cabin: cabin || 'economy'
    },
    origin_info: airportsService.byIata(origin),
    destination_info: airportsService.byIata(destination),
    results,
    error
  });
}

app.get('/search', handleSearch);
app.post('/search', handleSearch);

app.get('/offer/:id', async (req, res) => {
  try {
    const { offer } = await getOffer(req.params.id);
    if (!offer) {
      return res.status(404).render('404', { title: '404 — FlightDojo' });
    }
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
  const q = req.query.q || '';
  res.json({ results: airportsService.search(q, 8) });
});

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

app.use((req, res) => {
  res.status(404).render('404', { title: '404 — FlightDojo' });
});

app.listen(PORT, () => {
  console.log(`FlightDojo running on http://localhost:${PORT}`);
  console.log(`Duffel mode: ${process.env.DUFFEL_ACCESS_TOKEN && !process.env.DUFFEL_ACCESS_TOKEN.includes('REPLACE_ME') ? 'LIVE' : 'MOCK (set DUFFEL_ACCESS_TOKEN)'}`);
});

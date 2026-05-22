// SEO defaults middleware.
// Populates res.locals.seo with safe defaults on every request. Per-route
// renders can override individual fields by passing { seo: { ... } } in
// res.render(). The head.ejs partial reads from res.locals.seo to emit
// titles, meta descriptions, canonical URLs, OG/Twitter tags, JSON-LD.

const SITE_NAME = 'FlightDojo';
const DEFAULT_TITLE = 'FlightDojo — Find. Book. Fly.';
const DEFAULT_DESCRIPTION = 'FlightDojo finds you precision flights with zero hidden fees and 24/7 human support. Search 500+ airlines and book in minutes.';
const DEFAULT_OG_IMAGE = '/og-default.png';   // 1200x630, served from /public

// Routes that should never be indexed. Matched with startsWith().
const NEVER_INDEX_PATHS = [
  '/account',
  '/admin',
  '/api',
  '/booking/',
  '/offer/',
  '/search',
  '/login',
  '/signup',
  '/forgot',
  '/reset',
  '/webhooks'
];

// Routes where we strip query strings from the canonical URL.
// (Search-results page is allowed to keep query in the URL because we'll
// noindex it anyway.)
function buildCanonical(baseUrl, originalUrl) {
  // Strip query and trailing slash for canonical
  const cleanPath = (originalUrl || '/').split('?')[0].replace(/\/+$/, '') || '/';
  return baseUrl.replace(/\/+$/, '') + cleanPath;
}

function shouldNoIndex(path) {
  return NEVER_INDEX_PATHS.some(p => path === p || path.startsWith(p + '/') || path.startsWith(p));
}

function attachSeoDefaults(req, res, next) {
  const baseUrl = (process.env.BASE_URL || 'https://flightdojo.it.com').replace(/\/+$/, '');
  const canonical = buildCanonical(baseUrl, req.path);
  const noindex = shouldNoIndex(req.path);

  res.locals.seo = {
    site_name: SITE_NAME,
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    canonical,
    og_image: baseUrl + DEFAULT_OG_IMAGE,
    og_type: 'website',
    twitter_card: 'summary_large_image',
    twitter_handle: '@flightdojo',
    locale: 'en_US',
    noindex,
    base_url: baseUrl
  };
  next();
}

module.exports = {
  attachSeoDefaults,
  SITE_NAME,
  DEFAULT_TITLE,
  DEFAULT_DESCRIPTION,
  buildCanonical,
  shouldNoIndex
};

const https = require('https');
const curated = require('./airports-data');

const REMOTE_URL = 'https://api.travelpayouts.com/data/en/airports.json';
const BOOTSTRAP_TIMEOUT_MS = 5000;

// Common alternate names / historical names → official city
// Maps a lowercase user query → city name (lowercase, accent-stripped) we should match
const ALIASES = {
  'bangalore': 'bengaluru',
  'bombay': 'mumbai',
  'calcutta': 'kolkata',
  'madras': 'chennai',
  'peking': 'beijing',
  'canton': 'guangzhou',
  'saigon': 'ho chi minh city',
  'bombay airport': 'mumbai',
  'rangoon': 'yangon',
  'bangkok airport': 'bangkok',
  'st petersburg': 'st. petersburg',
  'saint petersburg': 'st. petersburg',
  'leningrad': 'st. petersburg',
  'jeddah': 'jeddah',
  'phuket island': 'phuket',
  'kyiv': 'kyiv',
  'kiev': 'kyiv',
  'mexico df': 'mexico city',
  'cdmx': 'mexico city',
  'nyc': 'new york',
  'new york city': 'new york',
  'la': 'los angeles',
  'sf': 'san francisco',
  'chicagoland': 'chicago',
  'd.c.': 'washington',
  'washington dc': 'washington'
};

let airports = curated.slice();
let byIataIndex = new Map();
let source = 'curated';

// strip diacritics + lowercase for matching: "São Paulo" → "sao paulo"
function fold(s) {
  if (!s) return '';
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function rebuildIndex() {
  byIataIndex.clear();
  for (const a of airports) {
    if (a.iata) byIataIndex.set(a.iata.toUpperCase(), a);
    // precompute folded fields for fast search
    a._iataLc = (a.iata || '').toLowerCase();
    a._cityF = fold(a.city);
    a._nameF = fold(a.name);
    a._countryF = fold(a.country);
  }
}
rebuildIndex();

function loadRemote() {
  if (process.env.AIRPORTS_USE_REMOTE !== '1') {
    console.log(`📍 Airports: using curated dataset (${airports.length} entries). Set AIRPORTS_USE_REMOTE=1 to load full Travelpayouts dataset on startup.`);
    return;
  }
  console.log('📍 Airports: fetching full dataset from Travelpayouts…');

  const req = https.get(REMOTE_URL, { timeout: BOOTSTRAP_TIMEOUT_MS }, (res) => {
    if (res.statusCode !== 200) {
      console.warn(`📍 Airports: remote fetch failed (HTTP ${res.statusCode}), keeping curated dataset.`);
      res.resume();
      return;
    }
    let chunks = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { chunks += chunk; });
    res.on('end', () => {
      try {
        const raw = JSON.parse(chunks);
        const filtered = raw
          .filter(a => a && a.code && a.flightable && a.iata_type === 'airport' && a.name)
          .map(a => {
            const enName = a.name_translations?.en || a.name;
            const curatedHit = byIataIndex.get(a.code.toUpperCase());
            return {
              iata: a.code,
              name: enName,
              city: a.city_code || enName,
              country: a.country_code || '',
              rank: curatedHit ? curatedHit.rank : 30
            };
          });

        // curated entries win on collision (better names/cities/ranks)
        const map = new Map();
        for (const a of filtered) map.set(a.iata, a);
        for (const c of curated) map.set(c.iata, c);
        airports = Array.from(map.values());
        rebuildIndex();
        source = 'remote';
        console.log(`📍 Airports: loaded ${airports.length} airports from Travelpayouts.`);
      } catch (err) {
        console.warn('📍 Airports: parse error, keeping curated dataset.', err.message);
      }
    });
  });

  req.on('error', (err) => {
    console.warn(`📍 Airports: remote fetch error (${err.message}), keeping curated dataset.`);
  });
  req.on('timeout', () => {
    console.warn('📍 Airports: remote fetch timed out, keeping curated dataset.');
    req.destroy();
  });
}

function scoreAirport(airport, qIata, qFold) {
  const iata = airport._iataLc;
  const city = airport._cityF;
  const name = airport._nameF;
  const country = airport._countryF;
  const rank = airport.rank || 30;

  if (iata === qIata) return 10000 + rank;
  if (city === qFold) return 8000 + rank;
  if (city.startsWith(qFold)) return 6000 + rank;
  if (iata.startsWith(qIata)) return 5000 + rank;
  if (name.startsWith(qFold)) return 4000 + rank;
  if (city.includes(qFold)) return 3000 + rank;
  if (name.includes(qFold)) return 2000 + rank;
  if (country === qFold) return 1500 + rank;
  if (country.startsWith(qFold)) return 1000 + rank;
  if (country.includes(qFold)) return 500 + rank;
  return 0;
}

function search(query, limit = 8) {
  if (!query) return [];
  const trimmed = query.trim();
  if (trimmed.length < 1) return [];
  const qLower = trimmed.toLowerCase();
  const qResolved = ALIASES[qLower] || qLower;
  const qFold = fold(qResolved);
  const qIata = qLower;

  const scored = [];
  for (const a of airports) {
    const score = scoreAirport(a, qIata, qFold);
    if (score > 0) scored.push({ a, score });
  }
  scored.sort((x, y) => y.score - x.score);
  // strip internal index fields before returning
  return scored.slice(0, limit).map(s => ({
    iata: s.a.iata,
    name: s.a.name,
    city: s.a.city,
    country: s.a.country
  }));
}

function byIata(iata) {
  if (!iata) return null;
  const a = byIataIndex.get(iata.toUpperCase());
  if (!a) return null;
  return { iata: a.iata, name: a.name, city: a.city, country: a.country };
}

function stats() {
  return { count: airports.length, source };
}

loadRemote();

module.exports = { search, byIata, stats };

const { Duffel } = require('@duffel/api');

const token = process.env.DUFFEL_ACCESS_TOKEN;

if (!token || token === 'duffel_test_REPLACE_ME') {
  console.warn('⚠  DUFFEL_ACCESS_TOKEN not set — flight search will return mock data');
}

const duffel = token && token !== 'duffel_test_REPLACE_ME'
  ? new Duffel({ token })
  : null;

const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(params) {
  return JSON.stringify(params);
}

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function setCached(key, data) {
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 100) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function formatDuration(iso) {
  if (!iso) return '';
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return iso;
  const [, h, m] = match;
  return `${h || 0}h ${m || 0}m`;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
}

function normalizeOffer(offer) {
  const slices = (offer.slices || []).map(slice => {
    const segments = slice.segments || [];
    const first = segments[0] || {};
    const last = segments[segments.length - 1] || {};
    return {
      origin: slice.origin?.iata_code,
      origin_name: slice.origin?.name,
      destination: slice.destination?.iata_code,
      destination_name: slice.destination?.name,
      duration: formatDuration(slice.duration),
      duration_raw: slice.duration,
      departure_time: formatTime(first.departing_at),
      departure_date: formatDate(first.departing_at),
      departure_iso: first.departing_at,
      arrival_time: formatTime(last.arriving_at),
      arrival_iso: last.arriving_at,
      stops: Math.max(segments.length - 1, 0),
      segments: segments.map(s => ({
        origin: s.origin?.iata_code,
        destination: s.destination?.iata_code,
        carrier: s.marketing_carrier?.name,
        carrier_iata: s.marketing_carrier?.iata_code,
        carrier_logo: s.marketing_carrier?.logo_symbol_url,
        flight_number: s.marketing_carrier_flight_number,
        departing_at: s.departing_at,
        arriving_at: s.arriving_at,
        aircraft: s.aircraft?.name
      }))
    };
  });

  const primaryCarrier = offer.owner;

  return {
    id: offer.id,
    total_amount: offer.total_amount,
    total_currency: offer.total_currency,
    base_amount: offer.base_amount,
    tax_amount: offer.tax_amount,
    expires_at: offer.expires_at,
    carrier: primaryCarrier?.name,
    carrier_iata: primaryCarrier?.iata_code,
    carrier_logo: primaryCarrier?.logo_symbol_url,
    slices,
    passenger_count: (offer.passengers || []).length
  };
}

async function searchOffers({
  origin,
  destination,
  depart_date,
  return_date,
  passengers = 1,
  cabin_class = 'economy',
  max_connections
}) {
  if (!duffel) {
    return mockOffers({ origin, destination, depart_date, return_date, passengers });
  }

  const key = cacheKey({ origin, destination, depart_date, return_date, passengers, cabin_class, max_connections });
  const cached = getCached(key);
  if (cached) return cached;

  const slices = [{ origin, destination, departure_date: depart_date }];
  if (return_date) {
    slices.push({ origin: destination, destination: origin, departure_date: return_date });
  }

  const passengerList = Array.from({ length: Math.max(1, parseInt(passengers, 10) || 1) },
    () => ({ type: 'adult' }));

  const opts = {
    slices,
    passengers: passengerList,
    cabin_class
  };
  if (max_connections !== undefined && max_connections !== null && max_connections !== '') {
    opts.max_connections = parseInt(max_connections, 10);
  }

  const response = await duffel.offerRequests.create({
    ...opts,
    return_offers: true
  });

  const offers = (response.data?.offers || [])
    .map(normalizeOffer)
    .sort((a, b) => parseFloat(a.total_amount) - parseFloat(b.total_amount))
    .slice(0, 25);

  const result = {
    offers,
    offer_request_id: response.data?.id,
    search: { origin, destination, depart_date, return_date, passengers, cabin_class }
  };

  setCached(key, result);
  return result;
}

async function getOffer(offerId) {
  if (!duffel) {
    return { offer: null, error: 'Duffel not configured' };
  }
  const response = await duffel.offers.get(offerId, { return_available_services: false });
  return { offer: normalizeOffer(response.data) };
}

function mockOffers({ origin, destination, depart_date, return_date, passengers }) {
  const carriers = [
    { name: 'British Airways', iata: 'BA' },
    { name: 'Lufthansa', iata: 'LH' },
    { name: 'Emirates', iata: 'EK' },
    { name: 'Air India', iata: 'AI' }
  ];
  const offers = carriers.map((c, i) => {
    const base = 280 + i * 60;
    return {
      id: `mock_offer_${i}`,
      total_amount: String(base + Math.floor(Math.random() * 80)),
      total_currency: 'EUR',
      base_amount: String(base - 40),
      tax_amount: '40',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      carrier: c.name,
      carrier_iata: c.iata,
      carrier_logo: null,
      slices: [{
        origin, destination,
        origin_name: origin, destination_name: destination,
        duration: `${8 + i}h ${15 + i * 5}m`,
        departure_time: `${8 + i}:30`,
        departure_date: depart_date,
        arrival_time: `${17 + i}:45`,
        stops: i === 0 ? 0 : 1,
        segments: []
      }],
      passenger_count: parseInt(passengers, 10) || 1
    };
  });
  return {
    offers,
    offer_request_id: 'mock',
    search: { origin, destination, depart_date, return_date, passengers },
    mock: true
  };
}

module.exports = { searchOffers, getOffer, normalizeOffer };

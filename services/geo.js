// Geo-based airport recommendation + per-country popular destinations.
// Used by the home page to prefill the search form with a sensible default.
const airportCoords = require('./airport-coords');
const airportsService = require('./airports');

// Haversine distance in km
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Given lat/lon, find the closest airport from our bundled coords table.
// Returns { iata, distance_km } or null if no match within 800km.
function nearestAirport(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;

  let best = null;
  for (const [iata, [aLat, aLon]] of Object.entries(airportCoords)) {
    const d = haversineKm(lat, lon, aLat, aLon);
    if (!best || d < best.distance_km) {
      best = { iata, distance_km: d };
    }
  }
  // Only return if reasonably close (within ~800km — roughly the diameter of
  // a major metro region. Avoids returning JFK when someone in Mexico is
  // missing from the dataset.)
  if (best && best.distance_km <= 800) return best;
  return null;
}

// Country-code → fallback departure airport (when we have country but no coords).
// Picks the largest international hub for that country.
const COUNTRY_DEFAULT_AIRPORT = {
  US: 'JFK', CA: 'YYZ', MX: 'MEX', BR: 'GRU', AR: 'EZE',
  GB: 'LHR', IE: 'DUB', FR: 'CDG', DE: 'FRA', NL: 'AMS',
  ES: 'MAD', IT: 'FCO', PT: 'LIS', CH: 'ZRH', AT: 'VIE',
  BE: 'BRU', DK: 'CPH', SE: 'ARN', NO: 'OSL', FI: 'HEL',
  PL: 'WAW', CZ: 'PRG', HU: 'BUD', RO: 'OTP', GR: 'ATH',
  TR: 'IST', IL: 'TLV', AE: 'DXB', SA: 'JED', QA: 'DOH',
  KW: 'KWI', BH: 'BAH', OM: 'MCT', JO: 'AMM', EG: 'CAI',
  MA: 'CMN', ZA: 'JNB', KE: 'NBO', ET: 'ADD', NG: 'LOS',
  IN: 'DEL', LK: 'CMB', NP: 'KTM', BD: 'DAC', PK: 'KHI',
  TH: 'BKK', SG: 'SIN', MY: 'KUL', ID: 'CGK', PH: 'MNL',
  HK: 'HKG', TW: 'TPE', JP: 'NRT', KR: 'ICN', CN: 'PEK',
  AU: 'SYD', NZ: 'AKL', FJ: 'NAN'
};

// Per-country popular destinations, hand-curated based on actual travel flows.
// Each destination has the IATA and a short tagline. ~6-8 per country.
const POPULAR_BY_COUNTRY = {
  IN: [
    { iata: 'DXB', label: 'Dubai', tag: 'Shopping & sun' },
    { iata: 'SIN', label: 'Singapore', tag: 'Family-friendly' },
    { iata: 'BKK', label: 'Bangkok', tag: 'Street food & temples' },
    { iata: 'LHR', label: 'London', tag: 'Historic capital' },
    { iata: 'KUL', label: 'Kuala Lumpur', tag: 'Twin Towers' },
    { iata: 'CDG', label: 'Paris', tag: 'City of light' },
    { iata: 'JFK', label: 'New York', tag: 'Iconic skyline' },
    { iata: 'IST', label: 'Istanbul', tag: 'Where east meets west' }
  ],
  US: [
    { iata: 'CUN', label: 'Cancún', tag: 'Caribbean beaches' },
    { iata: 'LHR', label: 'London', tag: 'Royal capital' },
    { iata: 'CDG', label: 'Paris', tag: 'Romance & art' },
    { iata: 'NRT', label: 'Tokyo', tag: 'Neon & ramen' },
    { iata: 'FCO', label: 'Rome', tag: 'Ancient history' },
    { iata: 'BCN', label: 'Barcelona', tag: 'Gaudí & tapas' },
    { iata: 'PUJ', label: 'Punta Cana', tag: 'All-inclusive paradise' },
    { iata: 'CDG', label: 'Reykjavík', tag: 'Northern lights' }
  ],
  GB: [
    { iata: 'BCN', label: 'Barcelona', tag: 'Tapas & beaches' },
    { iata: 'CDG', label: 'Paris', tag: 'Quick weekend' },
    { iata: 'AMS', label: 'Amsterdam', tag: 'Canals & culture' },
    { iata: 'FCO', label: 'Rome', tag: 'Eternal city' },
    { iata: 'JFK', label: 'New York', tag: 'Across the pond' },
    { iata: 'DXB', label: 'Dubai', tag: 'Winter sun' },
    { iata: 'ATH', label: 'Athens', tag: 'Ancient & coastal' },
    { iata: 'LIS', label: 'Lisbon', tag: 'Affordable charm' }
  ],
  AE: [
    { iata: 'LHR', label: 'London', tag: 'Cultural escape' },
    { iata: 'BKK', label: 'Bangkok', tag: 'Tropical break' },
    { iata: 'DEL', label: 'Delhi', tag: 'Subcontinent connection' },
    { iata: 'CDG', label: 'Paris', tag: 'European elegance' },
    { iata: 'IST', label: 'Istanbul', tag: 'Historic bridge city' },
    { iata: 'MLE', label: 'Maldives', tag: 'Island paradise' },
    { iata: 'JFK', label: 'New York', tag: 'Long-haul classic' },
    { iata: 'NRT', label: 'Tokyo', tag: 'Eastern adventure' }
  ],
  AU: [
    { iata: 'DPS', label: 'Bali', tag: 'Tropical escape' },
    { iata: 'BKK', label: 'Bangkok', tag: 'Asian gateway' },
    { iata: 'NRT', label: 'Tokyo', tag: 'Cherry blossom' },
    { iata: 'LHR', label: 'London', tag: 'Long-haul to UK' },
    { iata: 'LAX', label: 'Los Angeles', tag: 'US gateway' },
    { iata: 'AKL', label: 'Auckland', tag: 'Across the Tasman' },
    { iata: 'SIN', label: 'Singapore', tag: 'Stopover favourite' },
    { iata: 'DEL', label: 'Delhi', tag: 'Indian adventure' }
  ],
  // Default / catch-all for any country we don't have curated lists for.
  // Globally popular destinations.
  _default: [
    { iata: 'DXB', label: 'Dubai', tag: 'Luxury & sun' },
    { iata: 'CDG', label: 'Paris', tag: 'City of light' },
    { iata: 'LHR', label: 'London', tag: 'Historic capital' },
    { iata: 'BKK', label: 'Bangkok', tag: 'Street food & temples' },
    { iata: 'JFK', label: 'New York', tag: 'Iconic skyline' },
    { iata: 'SIN', label: 'Singapore', tag: 'Family-friendly' },
    { iata: 'FCO', label: 'Rome', tag: 'Ancient history' },
    { iata: 'IST', label: 'Istanbul', tag: 'East meets west' }
  ]
};

function popularDestinations(countryCode, originIata) {
  const cc = (countryCode || '').toUpperCase();
  let list = POPULAR_BY_COUNTRY[cc] || POPULAR_BY_COUNTRY._default;
  // Don't suggest the user's own origin airport as a destination
  if (originIata) {
    list = list.filter(d => d.iata !== originIata);
  }
  // Enrich with display name from our airport DB
  return list.map(d => {
    const ap = airportsService.byIata(d.iata);
    return {
      iata: d.iata,
      label: d.label,
      tag: d.tag,
      city: ap?.city || d.label,
      country: ap?.country || ''
    };
  });
}

// Main entry — takes the proxycheck result (or just country/coords) and
// returns the best guess of where the user is.
function locateFromIpData(ipData) {
  if (!ipData) return null;

  // Try lat/lon first — most accurate
  if (typeof ipData.latitude === 'number' && typeof ipData.longitude === 'number') {
    const near = nearestAirport(ipData.latitude, ipData.longitude);
    if (near) {
      const ap = airportsService.byIata(near.iata);
      return {
        origin_iata: near.iata,
        origin_city: ap?.city || ap?.name || near.iata,
        origin_country: ap?.country || ipData.country || '',
        country_code: ipData.country_code || null,
        city: ipData.city || null,
        method: 'coords',
        distance_km: Math.round(near.distance_km)
      };
    }
  }

  // Fall back to country-default airport
  if (ipData.country_code) {
    const fallbackIata = COUNTRY_DEFAULT_AIRPORT[ipData.country_code.toUpperCase()];
    if (fallbackIata) {
      const ap = airportsService.byIata(fallbackIata);
      return {
        origin_iata: fallbackIata,
        origin_city: ap?.city || fallbackIata,
        origin_country: ap?.country || ipData.country || '',
        country_code: ipData.country_code,
        city: ipData.city || null,
        method: 'country_default'
      };
    }
  }

  return null;
}

module.exports = {
  locateFromIpData,
  popularDestinations,
  nearestAirport,
  haversineKm
};

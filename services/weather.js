// Weather snapshot for a destination, used in the day-of-travel companion.
// Free tier of OpenWeatherMap: 60 calls/min, 1M calls/month.
// Get a key: https://home.openweathermap.org/api_keys
// If no key configured, returns null and the UI just hides the weather block.

const https = require('https');
const airportsService = require('./airports');
const airportCoords = require('./airport-coords');

const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;  // 1 hour

function fetchOpenWeather(lat, lon, apiKey) {
  return new Promise((resolve, reject) => {
    const path = `/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${apiKey}`;
    const req = https.request({
      hostname: 'api.openweathermap.org',
      path,
      method: 'GET',
      timeout: 4000
    }, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(chunks) });
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function forDestination(iataCode) {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return null;
  if (!iataCode) return null;

  const airport = airportsService.byIata(iataCode);
  let lat, lon;
  if (airportCoords[iataCode]) {
    [lat, lon] = airportCoords[iataCode];
  } else if (airport && airport.lat && airport.lon) {
    lat = airport.lat;
    lon = airport.lon;
  } else {
    return null;
  }

  const cacheKey = `${iataCode}:${Math.floor(Date.now() / CACHE_TTL_MS)}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const { statusCode, body } = await fetchOpenWeather(lat, lon, apiKey);
    if (statusCode !== 200 || !body.main) return null;
    const snapshot = {
      city: airport?.city || body.name,
      country: airport?.country || body.sys?.country,
      temp_c: Math.round(body.main.temp),
      feels_like_c: Math.round(body.main.feels_like),
      humidity: body.main.humidity,
      conditions: body.weather?.[0]?.main || '',
      description: body.weather?.[0]?.description || '',
      icon: body.weather?.[0]?.icon || '',
      wind_kph: Math.round((body.wind?.speed || 0) * 3.6),
      fetched_at: new Date().toISOString()
    };
    cache.set(cacheKey, snapshot);
    return snapshot;
  } catch (err) {
    console.warn('Weather fetch failed for', iataCode, '-', err.message);
    return null;
  }
}

module.exports = { forDestination };

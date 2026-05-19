const https = require('https');

const API_KEY = process.env.PROXYCHECK_API_KEY || '';
const VERSION = '11-February-2026';

// Risk gate policy (from proxycheck v3 docs):
//   0-25  + not anonymous  → allow
//   0-25  + anonymous      → challenge
//   26-50                  → challenge
//   51-75 + not anonymous  → challenge
//   51-75 + anonymous      → deny
//   76+                    → deny
// For payment we are STRICTER: anything anonymous/proxy/vpn/tor/scraper at all → deny.
function decideRecommendation({ riskScore, anonymous, proxy, vpn, tor, scraper, hosting }) {
  if (proxy || vpn || tor || scraper) return 'deny';
  if (anonymous) return 'deny';
  if (riskScore >= 76) return 'deny';
  if (hosting) return 'deny'; // datacenter IPs shouldn't be paying for flights
  if (riskScore >= 26) return 'challenge';
  return 'allow';
}

function isPrivateOrLocal(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function fetchProxyCheck(ip, tag) {
  return new Promise((resolve, reject) => {
    const path = `/v3/${encodeURIComponent(ip)}?ver=${VERSION}` +
      (API_KEY ? `&key=${API_KEY}` : '') +
      (tag ? `&tag=${encodeURIComponent(tag)}` : '');

    const options = {
      hostname: 'proxycheck.io',
      path,
      method: 'GET',
      timeout: 4000,
      headers: { 'User-Agent': 'FlightDojo/1.1' }
    };

    const req = https.request(options, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(chunks) });
        } catch (err) {
          reject(new Error('ProxyCheck parse error: ' + err.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('ProxyCheck timeout'));
    });
    req.end();
  });
}

async function check(ip, tag = 'flightdojo_payment') {
  if (!ip || isPrivateOrLocal(ip)) {
    return {
      ip: ip || 'unknown',
      anonymous: false,
      proxy: false, vpn: false, tor: false, hosting: false, scraper: false,
      risk_score: 0,
      confidence: 0,
      network_type: 'local',
      recommendation: 'allow',
      raw: { skipped: true, reason: 'local_or_private_ip' },
      checked_at: new Date()
    };
  }

  if (!API_KEY) {
    console.warn('⚠  PROXYCHECK_API_KEY not set — running in PERMISSIVE mode (all IPs allowed).');
    return {
      ip,
      anonymous: false,
      proxy: false, vpn: false, tor: false, hosting: false, scraper: false,
      risk_score: 0,
      confidence: 0,
      network_type: 'unchecked',
      recommendation: 'allow',
      raw: { skipped: true, reason: 'no_api_key' },
      checked_at: new Date()
    };
  }

  try {
    const { statusCode, body } = await fetchProxyCheck(ip, tag);

    if (statusCode !== 200 || (body.status !== 'ok' && body.status !== 'warning')) {
      console.warn('ProxyCheck non-OK response:', statusCode, body.status, body.message);
      // Fail-open on API errors so legitimate users aren't blocked by our outage.
      return {
        ip,
        anonymous: false,
        proxy: false, vpn: false, tor: false, hosting: false, scraper: false,
        risk_score: 0,
        confidence: 0,
        network_type: 'unchecked',
        recommendation: 'allow',
        raw: body,
        checked_at: new Date()
      };
    }

    const ipData = body[ip] || {};
    const detections = ipData.detections || {};
    const network = ipData.network || {};
    const location = ipData.location || {};
    const operator = ipData.operator || null;

    const riskScore = typeof ipData.risk_score === 'number' ? ipData.risk_score : 0;
    const confidence = typeof detections.confidence === 'number' ? detections.confidence : 0;

    const anonymous = !!detections.anonymous;
    const proxy = !!detections.proxy;
    const vpn = !!detections.vpn;
    const tor = !!detections.tor;
    const hosting = !!detections.hosting;
    const scraper = !!detections.scraper;

    const recommendation = decideRecommendation({
      riskScore, anonymous, proxy, vpn, tor, scraper, hosting
    });

    return {
      ip,
      anonymous, proxy, vpn, tor, hosting, scraper,
      risk_score: riskScore,
      confidence,
      network_type: (network.type || '').toLowerCase() || null,
      asn: network.asn || null,
      isp: network.provider || null,
      organisation: network.organisation || null,
      hostname: network.hostname || null,
      country: location.country_name || location.country || null,
      region: location.region_name || location.region || null,
      city: location.city || null,
      operator_name: operator?.name || null,
      operator_services: operator?.services || [],
      recommendation,
      raw: ipData,
      checked_at: new Date()
    };
  } catch (err) {
    console.warn('ProxyCheck error:', err.message);
    return {
      ip,
      anonymous: false,
      proxy: false, vpn: false, tor: false, hosting: false, scraper: false,
      risk_score: 0,
      confidence: 0,
      network_type: 'unchecked',
      recommendation: 'allow',
      raw: { error: err.message },
      checked_at: new Date()
    };
  }
}

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}

module.exports = { check, clientIp, isPrivateOrLocal };

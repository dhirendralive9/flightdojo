const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const TEST_SITEKEY = '1x00000000000000000000AA';
const TEST_SECRET = '1x0000000000000000000000000000000AA';

const sitekey = process.env.TURNSTILE_SITEKEY || TEST_SITEKEY;
const secret = process.env.TURNSTILE_SECRET || TEST_SECRET;
const isTestMode = secret === TEST_SECRET || secret.startsWith('1x000000');

if (isTestMode) {
  console.warn('⚠  Turnstile in TEST mode — all challenges auto-pass. Set TURNSTILE_SECRET for production.');
}

async function verify(token, remoteip) {
  if (!token) {
    return { success: false, error: 'No token provided' };
  }

  const body = new URLSearchParams();
  body.append('secret', secret);
  body.append('response', token);
  if (remoteip) body.append('remoteip', remoteip);

  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await res.json();
    return {
      success: !!data.success,
      hostname: data.hostname,
      challenge_ts: data.challenge_ts,
      error_codes: data['error-codes'] || [],
      error: data.success ? null : (data['error-codes'] || []).join(', ') || 'Verification failed'
    };
  } catch (err) {
    console.error('Turnstile verify network error:', err.message);
    return { success: false, error: 'Verification service unreachable' };
  }
}

module.exports = {
  verify,
  sitekey,
  isTestMode
};

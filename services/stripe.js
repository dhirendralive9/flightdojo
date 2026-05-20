const Stripe = require('stripe');

const key = process.env.STRIPE_SECRET_KEY;
const hasRealKey = key && !key.includes('REPLACE_ME');

if (!hasRealKey) {
  console.warn('⚠  STRIPE_SECRET_KEY not set — payment endpoints will return mock data');
}

const stripe = hasRealKey
  ? new Stripe(key)
  : null;

// On boot: identify which Stripe account this key belongs to.
// This is the #1 reason "I see no payments in my dashboard" — wrong account.
// The dashboard you should be looking at: https://dashboard.stripe.com/{account_id}/test/payments
if (stripe) {
  stripe.accounts.retrieve()
    .then(acct => {
      const mode = key.startsWith('sk_test_') ? 'TEST' : 'LIVE';
      console.log(`💳 Stripe ${mode} mode connected:`);
      console.log(`   Account ID: ${acct.id}`);
      console.log(`   Business:   ${acct.business_profile?.name || acct.settings?.dashboard?.display_name || '(unnamed)'}`);
      console.log(`   Country:    ${acct.country}`);
      console.log(`   Dashboard:  https://dashboard.stripe.com/${acct.id}/test/payments`);
      console.log(`   ⚠  If you don't see payments in your dashboard, you're probably`);
      console.log(`      looking at a DIFFERENT account or sandbox than this account ID.`);
    })
    .catch(err => {
      console.error('💳 ✗ Stripe key validation FAILED:', err.message);
      console.error('   Your STRIPE_SECRET_KEY is rejected by Stripe. Double-check it.');
    });
}

async function createPaymentIntent({ amount, currency, metadata, receipt_email }) {
  if (!stripe) {
    return {
      id: 'pi_mock_' + Math.random().toString(36).slice(2, 10),
      client_secret: 'pi_mock_secret_' + Math.random().toString(36).slice(2, 10),
      amount,
      currency,
      status: 'requires_payment_method',
      _mock: true
    };
  }

  const pi = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100), // dollars/euros → minor units
    currency: (currency || 'eur').toLowerCase(),
    payment_method_types: ['card'],
    metadata: metadata || {},
    receipt_email: receipt_email || undefined,
    description: metadata?.description || 'FlightDojo booking'
  });
  console.log(`💳 PaymentIntent created: ${pi.id} · ${pi.currency.toUpperCase()} ${(pi.amount/100).toFixed(2)} · order ${metadata?.order_reference || 'unknown'}`);
  return pi;
}

async function retrievePaymentIntent(id) {
  if (!stripe) return null;
  return stripe.paymentIntents.retrieve(id);
}

function constructWebhookEvent(rawBody, signature) {
  if (!stripe) {
    try { return JSON.parse(rawBody.toString('utf8')); }
    catch { return null; }
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || secret.includes('REPLACE_ME')) {
    console.warn('⚠  STRIPE_WEBHOOK_SECRET not set — webhook signature NOT verified');
    try { return JSON.parse(rawBody.toString('utf8')); }
    catch { return null; }
  }
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
  createPaymentIntent,
  retrievePaymentIntent,
  constructWebhookEvent,
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  hasRealKey
};

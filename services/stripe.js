const Stripe = require('stripe');

const key = process.env.STRIPE_SECRET_KEY;
const hasRealKey = key && !key.includes('REPLACE_ME');

if (!hasRealKey) {
  console.warn('⚠  STRIPE_SECRET_KEY not set — payment endpoints will return mock data');
}

const stripe = hasRealKey
  ? new Stripe(key, { apiVersion: '2025-09-30.acacia' })
  : null;

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

  return stripe.paymentIntents.create({
    amount: Math.round(amount * 100), // dollars/euros → minor units
    currency: (currency || 'eur').toLowerCase(),
    automatic_payment_methods: { enabled: true },
    metadata: metadata || {},
    receipt_email: receipt_email || undefined,
    description: metadata?.description || 'FlightDojo booking'
  });
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

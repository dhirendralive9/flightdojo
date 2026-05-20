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

async function createPaymentIntent({ amount, currency, metadata, receipt_email, billing }) {
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

  // Create a Stripe Customer with the full billing address so that:
  //   1. Stripe stores the address on the customer record (visible in dashboard)
  //   2. The receipt is sent with billing email + address
  //   3. Future bookings from the same email can reuse the customer
  //   4. Tax + invoice features can be enabled later without schema changes
  let customerId;
  if (billing && billing.email) {
    try {
      // Reuse existing customer if email already known, else create new
      const existing = await stripe.customers.list({ email: billing.email, limit: 1 });
      if (existing.data.length > 0) {
        customerId = existing.data[0].id;
        await stripe.customers.update(customerId, {
          name: billing.name || undefined,
          phone: billing.phone || undefined,
          address: {
            line1: billing.line1 || undefined,
            line2: billing.line2 || undefined,
            city: billing.city || undefined,
            state: billing.state || undefined,
            postal_code: billing.postal_code || undefined,
            country: billing.country || undefined
          },
          metadata: { company: billing.company || '' }
        });
      } else {
        const customer = await stripe.customers.create({
          email: billing.email,
          name: billing.name || undefined,
          phone: billing.phone || undefined,
          address: {
            line1: billing.line1 || undefined,
            line2: billing.line2 || undefined,
            city: billing.city || undefined,
            state: billing.state || undefined,
            postal_code: billing.postal_code || undefined,
            country: billing.country || undefined
          },
          metadata: { company: billing.company || '', source: 'flightdojo' }
        });
        customerId = customer.id;
      }
    } catch (err) {
      console.warn('💳 Customer create/update failed (continuing without):', err.message);
    }
  }

  const pi = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100), // dollars/euros → minor units
    currency: (currency || 'eur').toLowerCase(),
    customer: customerId || undefined,
    payment_method_types: ['card'],
    metadata: metadata || {},
    receipt_email: receipt_email || undefined,
    description: metadata?.description || 'FlightDojo booking'
  });
  console.log(`💳 PaymentIntent created: ${pi.id} · ${pi.currency.toUpperCase()} ${(pi.amount/100).toFixed(2)} · order ${metadata?.order_reference || 'unknown'}${customerId ? ' · customer ' + customerId : ''}`);
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

async function listPaymentMethods(stripeCustomerEmail) {
  if (!stripe || !stripeCustomerEmail) return [];
  try {
    const customers = await stripe.customers.list({ email: stripeCustomerEmail, limit: 1 });
    if (customers.data.length === 0) return [];
    const customerId = customers.data[0].id;
    const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 20 });
    return pms.data.map(pm => ({
      id: pm.id,
      brand: pm.card?.brand || 'card',
      last4: pm.card?.last4 || '••••',
      exp_month: pm.card?.exp_month,
      exp_year: pm.card?.exp_year,
      country: pm.card?.country || null,
      created: pm.created
    }));
  } catch (err) {
    console.warn('listPaymentMethods failed:', err.message);
    return [];
  }
}

async function detachPaymentMethod(paymentMethodId) {
  if (!stripe || !paymentMethodId) return { ok: false };
  try {
    await stripe.paymentMethods.detach(paymentMethodId);
    return { ok: true };
  } catch (err) {
    console.warn('detachPaymentMethod failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function refundPaymentIntent(paymentIntentId, amount, reason) {
  if (!stripe) return { ok: false, error: 'Stripe not configured' };
  if (!paymentIntentId) return { ok: false, error: 'No payment intent ID' };
  try {
    const params = {
      payment_intent: paymentIntentId,
      metadata: { reason: reason || 'requested_by_customer' }
    };
    if (amount && parseFloat(amount) > 0) {
      params.amount = Math.round(parseFloat(amount) * 100);
    }
    const refund = await stripe.refunds.create(params);
    return {
      ok: true,
      refund_id: refund.id,
      amount: (refund.amount / 100).toFixed(2),
      currency: refund.currency.toUpperCase(),
      status: refund.status
    };
  } catch (err) {
    console.error('Refund failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  createPaymentIntent,
  retrievePaymentIntent,
  constructWebhookEvent,
  listPaymentMethods,
  detachPaymentMethod,
  refundPaymentIntent,
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  hasRealKey
};

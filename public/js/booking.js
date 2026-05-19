(function() {
  let stripe = null;
  let elements = null;
  let paymentElement = null;
  let clientSecret = null;
  let paymentIntentId = null;
  let orderReference = null;
  let intentRequested = false;
  let isPaying = false;

  function init() {
    if (!window.FD_STRIPE_PK || window.FD_STRIPE_PK.includes('REPLACE_ME')) {
      showMessage('Payment is unavailable — Stripe is not configured.', 'error');
      return;
    }
    stripe = Stripe(window.FD_STRIPE_PK);

    const form = document.getElementById('bookingForm');
    if (!form) return;

    form.addEventListener('submit', onSubmit);
    form.addEventListener('input', onFormChange);
    form.addEventListener('change', onFormChange);

    // Re-render Stripe element when theme changes
    document.getElementById('themeToggle')?.addEventListener('click', () => {
      if (paymentElement) {
        setTimeout(() => updatePaymentElementTheme(), 50);
      }
    });
  }

  function passengerFieldsValid() {
    const required = document.querySelectorAll('#step1 input[required], #step1 select[required], #step2 input[required]');
    for (const f of required) {
      if (!f.value || !f.value.trim()) return false;
      if (f.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.value)) return false;
    }
    return true;
  }

  function onFormChange() {
    if (intentRequested) return;
    if (passengerFieldsValid()) {
      requestIntent();
    }
  }

  async function requestIntent() {
    if (intentRequested) return;
    intentRequested = true;

    const form = document.getElementById('bookingForm');
    const formData = new FormData(form);
    const passengers = [];
    const passengerCount = window.FD_OFFER.passenger_count;

    for (let i = 0; i < passengerCount; i++) {
      passengers.push({
        type: formData.get(`passengers[${i}][type]`),
        title: formData.get(`passengers[${i}][title]`),
        given_name: formData.get(`passengers[${i}][given_name]`),
        family_name: formData.get(`passengers[${i}][family_name]`),
        born_on: formData.get(`passengers[${i}][born_on]`),
        gender: formData.get(`passengers[${i}][gender]`)
      });
    }

    const body = {
      offer_id: window.FD_OFFER.id,
      passengers,
      contact_email: formData.get('contact_email'),
      contact_phone: formData.get('contact_phone')
    };

    showPaymentLoading();

    try {
      const res = await fetch('/api/book/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();

      if (!res.ok) {
        // 403 = blocked by ProxyCheck
        if (res.status === 403 && data.error === 'payment_blocked') {
          showBlockedScreen(data);
          intentRequested = false; // allow retry after VPN off
          return;
        }
        throw new Error(data.message || data.error || 'Failed to start payment');
      }

      clientSecret = data.client_secret;
      paymentIntentId = data.payment_intent_id;
      orderReference = data.order_reference;

      if (data.mock) {
        showMessage(
          'Stripe is in mock mode (no STRIPE_SECRET_KEY set). Set real keys in .env to test the live payment flow.',
          'info'
        );
        unlockPayment();
        document.getElementById('paymentElement').innerHTML =
          '<div style="padding:16px;background:var(--coral-soft);border-radius:6px;font-size:13px;color:var(--text-muted);">Mock Stripe — no card form to render. <a href="/booking/' + orderReference + '" style="color:var(--coral);">Click here to simulate success</a>.</div>';
        document.getElementById('paymentElement').style.display = 'block';
        document.getElementById('payBtn').disabled = true;
        return;
      }

      mountPaymentElement();
    } catch (err) {
      console.error('Intent error:', err);
      intentRequested = false;
      showMessage(err.message || 'Could not start payment. Please try again.', 'error');
      lockPayment();
    }
  }

  function mountPaymentElement() {
    const appearance = buildAppearance();
    elements = stripe.elements({ clientSecret, appearance });
    paymentElement = elements.create('payment', {
      layout: { type: 'tabs', defaultCollapsed: false }
    });

    const paymentDiv = document.getElementById('paymentElement');
    paymentDiv.innerHTML = '';
    paymentDiv.style.display = 'block';
    paymentElement.mount('#paymentElement');

    paymentElement.on('ready', () => {
      unlockPayment();
    });

    paymentElement.on('change', (e) => {
      const btn = document.getElementById('payBtn');
      btn.disabled = !e.complete || isPaying;
    });
  }

  function updatePaymentElementTheme() {
    if (!elements) return;
    elements.update({ appearance: buildAppearance() });
  }

  function buildAppearance() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      theme: isDark ? 'night' : 'stripe',
      labels: 'floating',
      variables: {
        colorPrimary: '#FF5038',
        colorBackground: isDark ? '#1f1f1f' : '#ffffff',
        colorText: isDark ? '#f5f3ee' : '#1a1a1a',
        colorDanger: '#cc3322',
        fontFamily: '"Outfit", Helvetica, sans-serif',
        fontSizeBase: '14px',
        borderRadius: '6px',
        spacingUnit: '4px'
      },
      rules: {
        '.Input': {
          border: isDark ? '1px solid #2a2a2a' : '1px solid #e3ddd1',
          boxShadow: 'none'
        },
        '.Input:focus': {
          border: '1px solid #FF5038',
          boxShadow: '0 0 0 2px rgba(255,80,56,0.12)'
        },
        '.Label': {
          fontWeight: '600',
          letterSpacing: '0.04em',
          fontSize: '12px'
        }
      }
    };
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!stripe || !elements || !clientSecret || isPaying) return;
    isPaying = true;

    const btn = document.getElementById('payBtn');
    const label = document.getElementById('payBtnLabel');
    btn.disabled = true;
    label.textContent = 'Processing…';
    btn.querySelector('[data-lucide="lock"]')?.replaceWith(createSpinner());

    const returnUrl = window.location.origin + '/booking/' + orderReference;

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl }
    });

    // Only reachable on validation/card errors. 3DS flows hand control back via return_url.
    if (error) {
      isPaying = false;
      const isExpected = error.type === 'card_error' || error.type === 'validation_error';
      showMessage(isExpected ? error.message : 'An unexpected error occurred. Please try again.', 'error');
      btn.disabled = false;
      label.textContent = 'Pay securely';
      const spinner = btn.querySelector('.bk-spinner');
      if (spinner) {
        const lock = document.createElement('i');
        lock.setAttribute('data-lucide', 'lock');
        lock.style.width = '14px'; lock.style.height = '14px';
        spinner.replaceWith(lock);
        if (window.lucide) lucide.createIcons();
      }
    }
  }

  function createSpinner() {
    const s = document.createElement('span');
    s.className = 'bk-spinner';
    return s;
  }

  function unlockPayment() {
    document.getElementById('paymentSection').style.display = 'none';
    document.getElementById('payBtn').disabled = false;
  }

  function lockPayment() {
    document.getElementById('paymentSection').style.display = 'block';
    document.getElementById('paymentElement').style.display = 'none';
    document.getElementById('payBtn').disabled = true;
  }

  function showPaymentLoading() {
    const sec = document.getElementById('paymentSection');
    sec.innerHTML = '<div class="bk-payment-locked-msg"><span class="bk-spinner"></span><span>Preparing secure payment…</span></div>';
    sec.style.display = 'block';
  }

  function showMessage(msg, type) {
    const el = document.getElementById('paymentMessage');
    el.textContent = msg;
    el.className = 'bk-payment-message bk-message-' + (type || 'info');
    el.style.display = 'block';
  }

  function showBlockedScreen(data) {
    const sec = document.getElementById('paymentSection');
    const ipInfo = data.ip_info || {};
    sec.innerHTML = `
      <div class="bk-blocked">
        <div class="bk-blocked-icon">
          <i data-lucide="shield-x" style="width:32px;height:32px;"></i>
        </div>
        <div class="bk-blocked-title">Payment temporarily blocked</div>
        <div class="bk-blocked-msg">${data.message || 'Your network has been flagged as a potential risk.'}</div>
        ${ipInfo.isp ? `<div class="bk-blocked-detail">Network: ${ipInfo.isp} ${ipInfo.country ? '· ' + ipInfo.country : ''}</div>` : ''}
        <button type="button" class="btn-ghost-hero" onclick="window.location.reload()" style="margin-top:14px;">
          <i data-lucide="refresh-cw" style="width:13px;height:13px;"></i>
          Try again
        </button>
      </div>
    `;
    sec.style.display = 'block';
    document.getElementById('paymentElement').style.display = 'none';
    document.getElementById('payBtn').style.display = 'none';
    if (window.lucide) lucide.createIcons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

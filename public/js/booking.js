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

    setupDobInputs();

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

  // Globally recompute every passenger's DOB hidden from current segment values.
  // Called defensively right before submitting to the server.
  function syncAllDobHidden() {
    document.querySelectorAll('[data-dob-segments]').forEach(group => {
      const idx = group.dataset.dobSegments;
      const mm = document.querySelector(`[data-dob-mm="${idx}"]`);
      const dd = document.querySelector(`[data-dob-dd="${idx}"]`);
      const yy = document.querySelector(`[data-dob-yyyy="${idx}"]`);
      const hidden = document.querySelector(`[data-dob-hidden="${idx}"]`);
      const native = document.querySelector(`[data-dob-native="${idx}"]`);
      if (!hidden) return;

      // If native picker is currently visible and has a value, prefer it
      if (native && native.style.display !== 'none' && native.value) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(native.value)) {
          hidden.value = native.value;
          return;
        }
      }

      // Otherwise compute from segments
      if (!mm || !dd || !yy) return;
      // Pad single-digit month/day in case user didn't blur
      let mmV = (mm.value || '').replace(/\D/g, '');
      let ddV = (dd.value || '').replace(/\D/g, '');
      let yyV = (yy.value || '').replace(/\D/g, '');
      if (mmV.length === 1) mmV = '0' + mmV;
      if (ddV.length === 1) ddV = '0' + ddV;

      if (mmV.length === 2 && ddV.length === 2 && yyV.length === 4) {
        const result = validateDob(mmV, ddV, yyV);
        if (!result.error) {
          hidden.value = result.iso;
          // also update visible segments in case we padded
          mm.value = mmV; dd.value = ddV; yy.value = yyV;
          return;
        }
      }
      // If we couldn't construct a valid date, leave hidden blank
      hidden.value = '';
    });
  }

  // ─── DOB entry: 3-segment MM/DD/YYYY with native-calendar fallback ───
  function setupDobInputs() {
    document.querySelectorAll('[data-dob-segments]').forEach(group => {
      const idx = group.dataset.dobSegments;
      const mm = document.querySelector(`[data-dob-mm="${idx}"]`);
      const dd = document.querySelector(`[data-dob-dd="${idx}"]`);
      const yy = document.querySelector(`[data-dob-yyyy="${idx}"]`);
      const hidden = document.querySelector(`[data-dob-hidden="${idx}"]`);
      const errorEl = document.querySelector(`[data-dob-error="${idx}"]`);
      const native = document.querySelector(`[data-dob-native="${idx}"]`);
      const toggle = document.querySelector(`[data-dob-toggle="${idx}"]`);

      function clearError() { if (errorEl) errorEl.textContent = ''; }
      function setError(msg) { if (errorEl) errorEl.textContent = msg; }

      function recompute() {
        hidden.value = '';
        clearError();
        if (!mm.value && !dd.value && !yy.value) return; // empty

        if (mm.value.length === 0 || dd.value.length === 0 || yy.value.length !== 4) {
          // partial — don't validate yet, just clear hidden value
          return;
        }

        const result = validateDob(mm.value, dd.value, yy.value);
        if (result.error) {
          setError(result.error);
        } else {
          hidden.value = result.iso;
        }
      }

      // Numeric-only filtering + auto-advance + paste support
      function attachSegment(input, nextInput, prevInput, expectedLen) {
        input.addEventListener('input', (e) => {
          let v = e.target.value.replace(/\D/g, '').slice(0, expectedLen);
          e.target.value = v;
          if (v.length >= expectedLen && nextInput) nextInput.focus();
          recompute();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !input.value && prevInput) {
            prevInput.focus();
            // place caret at end
            const len = prevInput.value.length;
            prevInput.setSelectionRange(len, len);
          }
        });
        input.addEventListener('paste', (e) => {
          // Smart paste: detect MM-DD-YYYY, MM/DD/YYYY, YYYY-MM-DD, or just digits
          const text = (e.clipboardData || window.clipboardData).getData('text');
          if (!text) return;
          const parsed = parsePastedDob(text);
          if (parsed) {
            e.preventDefault();
            mm.value = parsed.mm;
            dd.value = parsed.dd;
            yy.value = parsed.yyyy;
            recompute();
            yy.focus();
            yy.setSelectionRange(4, 4);
          }
        });
        input.addEventListener('blur', () => {
          // pad single-digit months/days on blur
          if ((input === mm || input === dd) && input.value.length === 1) {
            input.value = '0' + input.value;
            recompute();
          }
        });
      }

      attachSegment(mm, dd, null, 2);
      attachSegment(dd, yy, mm, 2);
      attachSegment(yy, null, dd, 4);

      // Native date picker toggle
      let nativeMode = false;
      toggle?.addEventListener('click', () => {
        nativeMode = !nativeMode;
        if (nativeMode) {
          group.style.display = 'none';
          native.style.display = 'block';
          toggle.innerHTML = '<i data-lucide="hash" style="width:11px;height:11px;"></i> Type manually';
          // copy current value if any
          if (hidden.value) native.value = hidden.value;
          native.focus();
        } else {
          group.style.display = '';
          native.style.display = 'none';
          toggle.innerHTML = '<i data-lucide="calendar" style="width:11px;height:11px;"></i> Use calendar';
          mm.focus();
        }
        if (window.lucide) lucide.createIcons();
      });

      native.addEventListener('change', () => {
        // native sends YYYY-MM-DD
        const v = native.value;
        clearError();
        if (!v) { hidden.value = ''; return; }
        const [yyyy, mmStr, ddStr] = v.split('-');
        const result = validateDob(mmStr, ddStr, yyyy);
        if (result.error) {
          setError(result.error);
          hidden.value = '';
        } else {
          hidden.value = result.iso;
          // sync segments too so if user toggles back they see their date
          mm.value = mmStr; dd.value = ddStr; yy.value = yyyy;
        }
        onFormChange();
      });
    });
  }

  function parsePastedDob(text) {
    text = text.trim();
    // YYYY-MM-DD or YYYY/MM/DD
    let m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) return { mm: m[2].padStart(2, '0'), dd: m[3].padStart(2, '0'), yyyy: m[1] };
    // MM-DD-YYYY or MM/DD/YYYY
    m = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (m) return { mm: m[1].padStart(2, '0'), dd: m[2].padStart(2, '0'), yyyy: m[3] };
    // 8 digits MMDDYYYY
    m = text.match(/^(\d{2})(\d{2})(\d{4})$/);
    if (m) return { mm: m[1], dd: m[2], yyyy: m[3] };
    return null;
  }

  function validateDob(mmStr, ddStr, yyyyStr) {
    const month = parseInt(mmStr, 10);
    const day = parseInt(ddStr, 10);
    const year = parseInt(yyyyStr, 10);

    if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) {
      return { error: 'Enter a valid date' };
    }
    if (month < 1 || month > 12) return { error: 'Month must be 01–12' };
    if (day < 1 || day > 31)     return { error: 'Day must be 01–31' };

    const currentYear = new Date().getFullYear();
    if (year < 1900 || year > currentYear) return { error: 'Year must be 1900–' + currentYear };

    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
      return { error: 'Not a real date' };
    }
    if (d > new Date()) return { error: 'Date is in the future' };

    return {
      iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    };
  }

  function passengerFieldsValid() {
    // Sync DOB hidden fields first so we check current state
    syncAllDobHidden();

    const required = document.querySelectorAll('#step1 input[required]:not(.bk-dob-seg):not(.bk-dob-native), #step1 select[required], #step2 input[required]');
    for (const f of required) {
      if (!f.value || !f.value.trim()) return false;
      if (f.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.value)) return false;
    }
    const hiddenDobs = document.querySelectorAll('[data-dob-hidden]');
    if (hiddenDobs.length === 0) return false;
    for (const h of hiddenDobs) {
      if (!h.value || !/^\d{4}-\d{2}-\d{2}$/.test(h.value)) return false;
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

    // Defensive: sync every DOB hidden field from its segments before reading FormData.
    // This catches any race condition where the segment input handler hasn't yet written.
    syncAllDobHidden();

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

    // Last-resort guard: if any born_on is still empty after sync, abort cleanly
    for (let i = 0; i < passengers.length; i++) {
      if (!passengers[i].born_on) {
        intentRequested = false;
        showMessage(`Please complete the date of birth for passenger ${i + 1}.`, 'error');
        const pax = document.querySelector(`[data-pax-idx="${i}"]`);
        pax?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        pax?.classList.add('bk-pax-flash');
        setTimeout(() => pax?.classList.remove('bk-pax-flash'), 1600);
        lockPayment();
        return;
      }
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
          intentRequested = false;
          return;
        }
        // 400 = validation error (missing/invalid passenger field)
        if (res.status === 400) {
          intentRequested = false;
          showMessage(data.message || 'Please check the passenger details and try again.', 'error');
          // scroll back to passenger section if a specific passenger is at fault
          if (typeof data.passenger_index === 'number') {
            const pax = document.querySelector(`[data-pax-idx="${data.passenger_index}"]`);
            pax?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            pax?.classList.add('bk-pax-flash');
            setTimeout(() => pax?.classList.remove('bk-pax-flash'), 1600);
          }
          lockPayment();
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

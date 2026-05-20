(function() {
  // Set window.FD_DEBUG = true in DevTools console to see DOB sync reports
  console.log('[FlightDojo booking.js] loaded — build', document.querySelector('script[src*="booking.js"]')?.src.match(/v=(\d+)/)?.[1] || 'unknown');

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
    setupBillingPrefill();
    setupSavedTravelerAutofill();
    setupSeatMaps();
    setupBags();
    setupAffiliateTracking();

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
  // Returns an array of { idx, ok, iso, error } so callers can act on failures.
  function syncAllDobHidden() {
    const report = [];
    document.querySelectorAll('[data-dob-segments]').forEach(group => {
      const idx = group.dataset.dobSegments;
      const mm = document.querySelector(`[data-dob-mm="${idx}"]`);
      const dd = document.querySelector(`[data-dob-dd="${idx}"]`);
      const yy = document.querySelector(`[data-dob-yyyy="${idx}"]`);
      const hidden = document.querySelector(`[data-dob-hidden="${idx}"]`);
      const native = document.querySelector(`[data-dob-native="${idx}"]`);

      if (!hidden) {
        report.push({ idx, ok: false, error: 'hidden_field_missing' });
        return;
      }

      // If native picker is currently visible and has a value, prefer it
      if (native && native.style.display !== 'none' && native.value) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(native.value)) {
          hidden.value = native.value;
          report.push({ idx, ok: true, iso: native.value, source: 'native' });
          return;
        }
      }

      // Compute from segments
      if (!mm || !dd || !yy) {
        report.push({ idx, ok: false, error: 'segment_inputs_missing' });
        return;
      }
      let mmV = (mm.value || '').replace(/\D/g, '');
      let ddV = (dd.value || '').replace(/\D/g, '');
      let yyV = (yy.value || '').replace(/\D/g, '');
      if (mmV.length === 1) mmV = '0' + mmV;
      if (ddV.length === 1) ddV = '0' + ddV;

      if (mmV.length === 2 && ddV.length === 2 && yyV.length === 4) {
        const result = validateDob(mmV, ddV, yyV);
        if (!result.error) {
          hidden.value = result.iso;
          mm.value = mmV; dd.value = ddV; yy.value = yyV;
          report.push({ idx, ok: true, iso: result.iso, source: 'segments' });
          return;
        }
        report.push({ idx, ok: false, error: result.error, mm: mmV, dd: ddV, yyyy: yyV });
      } else {
        report.push({ idx, ok: false, error: 'incomplete', mm: mmV, dd: ddV, yyyy: yyV });
      }
      hidden.value = '';
    });
    if (window.FD_DEBUG) console.log('[DOB sync]', report);
    return report;
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

    const required = document.querySelectorAll('#step1 input[required]:not(.bk-dob-seg):not(.bk-dob-native), #step1 select[required], #step2 input[required], #step3 input[required], #step3 select[required]');
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

  // Read billing fields out of the form
  function collectBilling(formData) {
    const countrySelect = document.getElementById('billingCountry');
    const countryCode = formData.get('billing[country]') || '';
    const countryName = countrySelect?.selectedOptions[0]?.dataset?.name || '';
    return {
      name: (formData.get('billing[name]') || '').trim(),
      email: (formData.get('billing[email]') || '').trim(),
      company: (formData.get('billing[company]') || '').trim(),
      country: countryCode,
      country_name: countryName,
      line1: (formData.get('billing[line1]') || '').trim(),
      line2: (formData.get('billing[line2]') || '').trim(),
      city: (formData.get('billing[city]') || '').trim(),
      state: (formData.get('billing[state]') || '').trim(),
      postal_code: (formData.get('billing[postal_code]') || '').trim(),
      phone: (formData.get('contact_phone') || '').trim()
    };
  }

  // Prefill billing name from passenger 1 + email from contact, once the user
  // has filled those in. Doesn't overwrite anything the user has already typed.
  function setupBillingPrefill() {
    const billingName = document.getElementById('billingName');
    const billingEmail = document.getElementById('billingEmail');
    const contactEmail = document.getElementById('contactEmail');
    const pax1First = document.querySelector('[name="passengers[0][given_name]"]');
    const pax1Last = document.querySelector('[name="passengers[0][family_name]"]');

    function prefillName() {
      if (billingName && !billingName.value.trim()) {
        const first = pax1First?.value?.trim() || '';
        const last = pax1Last?.value?.trim() || '';
        const fullName = (first + ' ' + last).trim();
        if (fullName) billingName.value = fullName;
      }
    }
    function prefillEmail() {
      if (billingEmail && !billingEmail.value.trim()) {
        const e = contactEmail?.value?.trim() || '';
        if (e) billingEmail.value = e;
      }
    }

    // Trigger prefill when user moves focus out of the source fields
    pax1First?.addEventListener('blur', prefillName);
    pax1Last?.addEventListener('blur', prefillName);
    contactEmail?.addEventListener('blur', prefillEmail);

    // Also when the billing fields get focus, in case the user filled passenger
    // data but never blurred (e.g. tabbed straight through)
    billingName?.addEventListener('focus', prefillName);
    billingEmail?.addEventListener('focus', prefillEmail);
  }

  // ─── SAVED TRAVELER AUTOFILL ──────────────────────────────
  // When the user picks a saved traveler from the dropdown, populate that
  // passenger card's title/name/DOB/gender fields. The DOB segments need
  // special handling since they're not a single input.
  function setupSavedTravelerAutofill() {
    document.querySelectorAll('.bk-saved-traveler').forEach(select => {
      select.addEventListener('change', () => {
        if (!select.value) return;
        let data;
        try { data = JSON.parse(select.value); } catch (e) { return; }
        const paxIdx = select.dataset.paxTarget;
        const card = document.querySelector(`[data-pax-idx="${paxIdx}"]`);
        if (!card) return;

        const setField = (name, value) => {
          const el = card.querySelector(`[name="passengers[${paxIdx}][${name}]"]`);
          if (el && value !== undefined && value !== '') el.value = value;
        };
        setField('title', data.title || 'mr');
        setField('given_name', data.given_name || '');
        setField('family_name', data.family_name || '');
        setField('gender', data.gender || 'm');

        // DOB: split YYYY-MM-DD into the 3 segment inputs
        if (data.born_on && /^\d{4}-\d{2}-\d{2}$/.test(data.born_on)) {
          const [y, m, d] = data.born_on.split('-');
          const mm = card.querySelector(`.bk-dob-seg[data-seg="mm"][data-pax="${paxIdx}"]`);
          const dd = card.querySelector(`.bk-dob-seg[data-seg="dd"][data-pax="${paxIdx}"]`);
          const yy = card.querySelector(`.bk-dob-seg[data-seg="yyyy"][data-pax="${paxIdx}"]`);
          if (mm) mm.value = m;
          if (dd) dd.value = d;
          if (yy) yy.value = y;
          const hidden = card.querySelector(`[data-dob-hidden][data-pax="${paxIdx}"]`);
          if (hidden) hidden.value = data.born_on;
        }

        // Reset selector so the user can re-pick if needed
        select.value = '';
        onFormChange();
      });
    });
  }

  // ─── SEAT MAPS ────────────────────────────────────────────
  // selectedSeats[sliceIdx] = { passenger_index, designator, amount, currency, service_id }
  const selectedSeats = {};
  // Which passenger is currently picking? Default to 0 (passenger 1)
  let activeSeatPassenger = 0;

  function setupSeatMaps() {
    const container = document.getElementById('seatMapsContainer');
    if (!container) return;
    let maps;
    try {
      maps = JSON.parse(container.dataset.seatMaps || '[]');
    } catch (e) { return; }
    if (!maps.length) return;

    const passengerCount = parseInt(container.dataset.passengerCount, 10) || 1;

    // For each slice, find its seat map by matching slice_id (Duffel returns
    // one seat map per segment; we use the first segment of each slice for now).
    document.querySelectorAll('[data-slice-render-idx]').forEach((el, idx) => {
      const sliceIdx = parseInt(el.dataset.sliceRenderIdx, 10);
      // Pick the seat map for this slice — Duffel may return multiple (one per segment).
      // For simplicity we render the first one matching this slice_id, or just the Nth map.
      const map = maps[sliceIdx];
      if (!map) {
        el.innerHTML = '<div class="bk-seat-na">Seat map not available for this flight.</div>';
        return;
      }
      renderSeatMap(map, el, sliceIdx, passengerCount);
    });

    // Passenger selector strip at the top of the section
    if (passengerCount > 1) {
      const head = document.createElement('div');
      head.className = 'bk-seat-pax-strip';
      head.innerHTML = '<span>Choosing for:</span>';
      for (let i = 0; i < passengerCount; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bk-seat-pax-btn' + (i === 0 ? ' active' : '');
        btn.dataset.paxIdx = i;
        btn.textContent = `Passenger ${i + 1}`;
        btn.addEventListener('click', () => {
          activeSeatPassenger = i;
          document.querySelectorAll('.bk-seat-pax-btn').forEach(b =>
            b.classList.toggle('active', parseInt(b.dataset.paxIdx, 10) === i));
        });
        head.appendChild(btn);
      }
      container.insertBefore(head, container.firstChild);
    }
  }

  function renderSeatMap(map, mountEl, sliceIdx, passengerCount) {
    mountEl.innerHTML = '';
    map.cabins.forEach(cabin => {
      const cabinEl = document.createElement('div');
      cabinEl.className = 'bk-cabin';
      const cabinLabel = document.createElement('div');
      cabinLabel.className = 'bk-cabin-label';
      cabinLabel.textContent = (cabin.cabin_class || 'economy').toUpperCase();
      cabinEl.appendChild(cabinLabel);

      cabin.rows.forEach((row, rowIdx) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'bk-seat-row';
        row.sections.forEach((section, sectionIdx) => {
          if (sectionIdx > 0) {
            const aisle = document.createElement('div');
            aisle.className = 'bk-seat-aisle';
            rowEl.appendChild(aisle);
          }
          section.elements.forEach(element => {
            const cell = document.createElement('div');
            if (element.type === 'seat') {
              const svc = element.available_services[0]; // first matching passenger
              const isAvailable = svc !== undefined;
              const price = svc ? Math.round(parseFloat(svc.amount)) : 0;
              cell.className = 'bk-seat' + (isAvailable ? ' available' : ' unavailable');
              cell.dataset.designator = element.designator;
              cell.dataset.sliceIdx = sliceIdx;
              if (svc) {
                cell.dataset.serviceId = svc.id;
                cell.dataset.amount = svc.amount;
                cell.dataset.currency = svc.currency;
              }
              cell.innerHTML = `<span class="bk-seat-label">${element.designator || ''}</span>` +
                (isAvailable && price > 0 ? `<span class="bk-seat-price">${formatCurrency(svc.currency)}${price}</span>` : '');
              cell.title = element.designator + (price ? ` · ${formatCurrency(svc.currency)}${price}` : '');
              if (isAvailable) cell.addEventListener('click', () => onSeatClick(cell));
            } else if (element.type === 'empty') {
              cell.className = 'bk-seat-empty';
            } else {
              cell.className = 'bk-seat-feature bk-seat-' + element.type;
              cell.title = element.type.replace(/_/g, ' ');
            }
            rowEl.appendChild(cell);
          });
        });
        cabinEl.appendChild(rowEl);
      });
      mountEl.appendChild(cabinEl);
    });
  }

  function onSeatClick(cell) {
    const sliceIdx = parseInt(cell.dataset.sliceIdx, 10);
    const designator = cell.dataset.designator;
    const amount = cell.dataset.amount;
    const currency = cell.dataset.currency;
    const serviceId = cell.dataset.serviceId;

    // Toggle: if this seat was selected by this passenger, unselect
    const key = `${sliceIdx}:${activeSeatPassenger}`;
    const existing = selectedSeats[key];
    if (existing && existing.designator === designator) {
      delete selectedSeats[key];
    } else {
      // Remove any other selection by this passenger on this slice
      Object.keys(selectedSeats).forEach(k => {
        if (k === key) delete selectedSeats[k];
      });
      selectedSeats[key] = { passenger_index: activeSeatPassenger, slice_index: sliceIdx, designator, amount, currency, service_id: serviceId };
    }
    redrawSeatHighlights(sliceIdx);
    redrawPickedSummary(sliceIdx);
    onFormChange(); // recompute total
  }

  function redrawSeatHighlights(sliceIdx) {
    document.querySelectorAll(`[data-slice-render-idx="${sliceIdx}"] .bk-seat.available`).forEach(c => {
      c.classList.remove('selected', 'selected-other-pax');
    });
    Object.values(selectedSeats).forEach(s => {
      if (s.slice_index !== sliceIdx) return;
      const el = document.querySelector(`[data-slice-render-idx="${sliceIdx}"] [data-designator="${s.designator}"]`);
      if (!el) return;
      if (s.passenger_index === activeSeatPassenger) el.classList.add('selected');
      else el.classList.add('selected-other-pax');
    });
  }

  function redrawPickedSummary(sliceIdx) {
    const el = document.querySelector(`[data-slice-picked-idx="${sliceIdx}"]`);
    if (!el) return;
    const picks = Object.values(selectedSeats).filter(s => s.slice_index === sliceIdx);
    if (picks.length === 0) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = picks.map(p =>
      `<div class="bk-seat-picked-row">Passenger ${p.passenger_index + 1}: <strong>${p.designator}</strong> · ${formatCurrency(p.currency)}${Math.round(parseFloat(p.amount))}</div>`
    ).join('');
  }

  // ─── BAGS ────────────────────────────────────────────────
  // selectedBags[paxIdx] = { kind, max_weight_kg, quantity, amount, currency, service_id }
  const selectedBags = {};

  function setupBags() {
    const container = document.getElementById('bagsContainer');
    if (!container) return;
    let options;
    try {
      options = JSON.parse(container.dataset.bagOptions || '[]');
    } catch (e) { return; }
    if (!options.length) return;

    const passengerCount = parseInt(container.dataset.passengerCount, 10) || 1;
    for (let i = 0; i < passengerCount; i++) {
      const mount = container.querySelector(`[data-bag-options-pax="${i}"]`);
      if (!mount) continue;
      mount.innerHTML = '<div class="bk-bag-option-none active" data-pax="' + i + '" data-bag-none="1">None</div>' +
        options.map((opt, idx) =>
          `<div class="bk-bag-option" data-pax="${i}" data-bag-idx="${idx}"
                 data-service-id="${opt.id}"
                 data-amount="${opt.amount}"
                 data-currency="${opt.currency}"
                 data-kind="${opt.kind}"
                 data-weight="${opt.max_weight_kg || ''}">
            <div class="bk-bag-opt-icon"><i data-lucide="luggage" style="width:14px;height:14px;"></i></div>
            <div class="bk-bag-opt-body">
              <div class="bk-bag-opt-title">${opt.kind === 'carry_on' ? 'Carry-on' : 'Checked bag'}${opt.max_weight_kg ? ` · ${opt.max_weight_kg}kg` : ''}</div>
              <div class="bk-bag-opt-price">${formatCurrency(opt.currency)}${Math.round(parseFloat(opt.amount))}</div>
            </div>
          </div>`
        ).join('');
    }
    if (window.lucide) window.lucide.createIcons();

    // Wire click handlers
    container.querySelectorAll('.bk-bag-option, .bk-bag-option-none').forEach(el => {
      el.addEventListener('click', () => onBagClick(el));
    });
  }

  function onBagClick(el) {
    const pax = parseInt(el.dataset.pax, 10);
    const isNone = el.dataset.bagNone === '1';

    // Deselect all options for this passenger
    document.querySelectorAll(`[data-pax="${pax}"]`).forEach(o => o.classList.remove('active'));
    el.classList.add('active');

    if (isNone) {
      delete selectedBags[pax];
    } else {
      selectedBags[pax] = {
        passenger_index: pax,
        kind: el.dataset.kind,
        max_weight_kg: parseFloat(el.dataset.weight) || null,
        quantity: 1,
        amount: el.dataset.amount,
        currency: el.dataset.currency,
        service_id: el.dataset.serviceId
      };
    }
    onFormChange();
  }

  // ─── AFFILIATE CLICK TRACKING ─────────────────────────────
  function setupAffiliateTracking() {
    document.querySelectorAll('.bk-affiliate-card').forEach(card => {
      card.addEventListener('click', () => {
        const partner = card.dataset.affiliate;
        if (!partner) return;
        // Fire-and-forget; the link opens in a new tab regardless
        fetch('/api/affiliate/click', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ partner, order_reference: orderReference || null })
        }).catch(() => {});
      });
    });
  }

  // ─── COLLECT ALL ADDONS ───────────────────────────────────
  function collectAddons() {
    const seatNotes = document.querySelector('[name="addons[seat_preference_notes]"]')?.value?.trim() || '';
    const bagNotes = document.querySelector('[name="addons[bag_preference_notes]"]')?.value?.trim() || '';
    return {
      seats: Object.values(selectedSeats),
      seat_preference_notes: seatNotes,
      bags: Object.values(selectedBags),
      bag_preference_notes: bagNotes
    };
  }

  function formatCurrency(code) {
    return code === 'EUR' ? '€' : code === 'USD' ? '$' : code === 'GBP' ? '£' : (code || '') + ' ';
  }

  function onFormChange() {
    if (intentRequested) return;
    if (passengerFieldsValid()) {
      requestIntent();
    } else {
      // Clear stale error messages once the user starts editing again
      hideMessage();
    }
  }

  async function requestIntent() {
    if (intentRequested) return;
    intentRequested = true;

    // Clear any previous error message — we're trying again
    hideMessage();

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
      contact_phone: formData.get('contact_phone'),
      billing: collectBilling(formData),
      addons: collectAddons()
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
      layout: { type: 'tabs', defaultCollapsed: false },
      // Hide Stripe Link auto-fill prompt — we already collect email/phone above,
      // and we don't want users to "create a Link account" mid-checkout.
      wallets: { applePay: 'never', googlePay: 'never', link: 'never' },
      // Don't ask the user to re-enter contact details — we have them.
      fields: { billingDetails: { email: 'never', phone: 'never', name: 'auto' } }
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

    // Read billing for Stripe — used for AVS verification and Stripe receipt
    const formData = new FormData(document.getElementById('bookingForm'));
    const billing = collectBilling(formData);
    const contactPhone = document.getElementById('contactPhone')?.value || '';

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: returnUrl,
        payment_method_data: {
          billing_details: {
            name: billing.name || undefined,
            email: billing.email || undefined,
            phone: contactPhone || undefined,
            address: {
              line1: billing.line1 || undefined,
              line2: billing.line2 || undefined,
              city: billing.city || undefined,
              state: billing.state || undefined,
              postal_code: billing.postal_code || undefined,
              country: billing.country || undefined
            }
          }
        }
      }
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

  function hideMessage() {
    const el = document.getElementById('paymentMessage');
    if (!el) return;
    el.textContent = '';
    el.style.display = 'none';
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

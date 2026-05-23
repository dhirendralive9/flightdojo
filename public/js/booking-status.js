(function() {
  const reference = window.FD_BOOKING_REFERENCE;
  const initial = window.FD_INITIAL_STATUS;
  if (!reference) return;

  const loadingEl = document.getElementById('bksLoading');
  const successEl = document.getElementById('bksSuccess');
  const failedEl = document.getElementById('bksFailed');
  const failMsgEl = document.getElementById('bksFailMsg');

  const finishedStatuses = ['booked', 'ticketed', 'completed'];
  if (finishedStatuses.includes(initial)) return;

  let attempts = 0;
  const MAX_ATTEMPTS = 30; // ~60 seconds at 2s intervals

  async function poll() {
    attempts++;
    try {
      const res = await fetch('/api/booking/' + encodeURIComponent(reference) + '/status');
      if (!res.ok) throw new Error('status fetch failed');
      const data = await res.json();

      if (finishedStatuses.includes(data.status)) {
        // Reload to render the success view server-side (with PNR + itinerary)
        window.location.reload();
        return;
      }
      if (data.status === 'failed') {
        loadingEl.style.display = 'none';
        failedEl.style.display = 'flex';
        if (data.failure_reason && failMsgEl) {
          failMsgEl.textContent = data.failure_reason + ' Our team will reach out within 1 business hour.';
        }
        if (window.lucide) lucide.createIcons();
        return;
      }
    } catch (err) {
      console.warn('Poll error:', err.message);
    }

    if (attempts >= MAX_ATTEMPTS) {
      loadingEl.style.display = 'none';
      failedEl.style.display = 'flex';
      if (failMsgEl) {
        failMsgEl.textContent = 'Confirmation is taking longer than expected. Your payment is safe — please check your email or contact support with the order ID below.';
      }
      if (window.lucide) lucide.createIcons();
      return;
    }
    setTimeout(poll, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(poll, 1500));
  } else {
    setTimeout(poll, 1500);
  }
})();

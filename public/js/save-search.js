(function() {
  const btn = document.getElementById('saveSearchBtn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg> Saving…';

    const payload = {
      origin: btn.dataset.origin,
      destination: btn.dataset.destination,
      depart_date: btn.dataset.depart,
      return_date: btn.dataset.return || null,
      passengers: parseInt(btn.dataset.passengers, 10) || 1,
      cabin_class: btn.dataset.cabin || 'economy',
      baseline_price: btn.dataset.baselinePrice || null,
      baseline_currency: btn.dataset.baselineCurrency || 'USD'
    };

    try {
      const res = await fetch('/api/account/saved-searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="var(--coral)" stroke="var(--coral)" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> Watching · <a href="/account/saved-searches" style="color:var(--coral);text-decoration:underline;">View</a>';
        btn.classList.add('saved');
      } else {
        btn.innerHTML = orig;
        alert(data.error || 'Could not save search.');
        btn.disabled = false;
      }
    } catch (err) {
      btn.innerHTML = orig;
      alert('Network error.');
      btn.disabled = false;
    }
  });
})();

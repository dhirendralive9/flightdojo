(function() {
  // Check-now buttons
  document.querySelectorAll('[data-check]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.check;
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin"><circle cx="12" cy="12" r="10"/><path d="M12 2v4"/></svg> Checking…';
      try {
        const res = await fetch(`/api/account/saved-searches/${id}/check`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          if (data.no_results) {
            btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4M12 16h.01"/></svg> No flights';
          } else if (data.drop_percent > 0) {
            btn.innerHTML = `↓ ${data.drop_percent}% — reloading`;
            setTimeout(() => window.location.reload(), 800);
          } else if (data.drop_percent < 0) {
            btn.innerHTML = `↑ ${Math.abs(data.drop_percent)}% — reloading`;
            setTimeout(() => window.location.reload(), 800);
          } else {
            btn.innerHTML = 'Same price — reloading';
            setTimeout(() => window.location.reload(), 800);
          }
        } else {
          btn.innerHTML = orig;
          alert(data.error || 'Could not check now.');
        }
      } catch (err) {
        btn.innerHTML = orig;
        alert('Network error.');
      }
      setTimeout(() => { btn.disabled = false; }, 1500);
    });
  });

  // Remove buttons
  document.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Stop watching this route?')) return;
      const id = btn.dataset.remove;
      try {
        await fetch(`/api/account/saved-searches/${id}`, { method: 'DELETE' });
        const card = btn.closest('.saved-search-card');
        if (card) {
          card.style.transition = 'opacity 0.25s, transform 0.25s';
          card.style.opacity = '0';
          card.style.transform = 'translateX(-12px)';
          setTimeout(() => card.remove(), 260);
        }
      } catch (err) {
        alert('Could not remove. Try again.');
      }
    });
  });
})();

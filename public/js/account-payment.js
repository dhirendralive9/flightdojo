(function() {
  document.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.remove;
      if (!confirm('Remove this card from your saved payment methods? You can always add it back by paying with it again.')) return;
      btn.disabled = true;
      const card = btn.closest('.pm-card');
      try {
        const res = await fetch(`/api/account/payment-methods/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok && data.ok) {
          card.style.transition = 'opacity 0.3s, transform 0.3s';
          card.style.opacity = '0';
          card.style.transform = 'translateX(-20px)';
          setTimeout(() => card.remove(), 320);
        } else {
          alert(data.error || 'Could not remove card.');
          btn.disabled = false;
        }
      } catch (err) {
        alert('Network error. Try again.');
        btn.disabled = false;
      }
    });
  });
})();

(function() {
  // ─── MODAL HELPERS ───
  function openModal(id) {
    const m = document.getElementById(id);
    if (m) {
      m.style.display = 'flex';
      // focus first input
      setTimeout(() => m.querySelector('input, textarea, select')?.focus(), 50);
    }
  }
  function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.style.display = 'none';
  }

  // Wire close buttons + backdrop clicks for all modals
  document.querySelectorAll('[data-modal]').forEach(modal => {
    modal.querySelectorAll('[data-modal-close]').forEach(el => {
      el.addEventListener('click', () => modal.style.display = 'none');
    });
  });

  // ─── ACTION TRIGGERS ───
  document.querySelectorAll('[data-action]').forEach(btn => {
    const action = btn.dataset.action;
    btn.addEventListener('click', () => {
      if (action === 'ticket') openModal('ticketModal');
      else if (action === 'refund') openModal('refundModal');
      else if (action === 'email') openModal('emailModal');
      else if (action === 'note') openModal('noteModal');
      else if (action === 'cancel') openModal('cancelModal');
      else if (action === 'complete') {
        if (!confirm('Mark this order as completed?')) return;
        postAction(btn.dataset.ref, 'complete');
      }
      else if (action === 'trigger-reset') {
        if (!confirm('Send a password reset link to this user?')) return;
        postUserAction(btn.dataset.userId, 'trigger-reset');
      }
    });
  });

  async function postAction(ref, action, body) {
    const res = await fetch(`/api/admin/orders/${ref}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      window.location.reload();
    } else {
      alert(data.error || 'Action failed.');
    }
  }

  async function postUserAction(userId, action) {
    const res = await fetch(`/api/admin/users/${userId}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.ok) {
      alert('Done. Password reset email sent.');
    } else {
      alert(data.error || 'Action failed.');
    }
  }

  // ─── TICKET FORM ───
  document.getElementById('ticketForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ref = document.querySelector('[data-action="ticket"]')?.dataset.ref;
    await postAction(ref, 'ticket', {
      pnr: fd.get('pnr'),
      note: fd.get('note')
    });
  });

  // ─── REFUND FORM ───
  document.getElementById('refundForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ref = document.querySelector('[data-action="refund"]')?.dataset.ref;
    if (!confirm(`Issue refund of ${fd.get('amount')} for order ${ref}? This will trigger Stripe immediately.`)) return;
    await postAction(ref, 'refund', {
      amount: fd.get('amount'),
      reason: fd.get('reason'),
      notes: fd.get('notes'),
      confirm_ref: fd.get('confirm_ref')
    });
  });

  // ─── EMAIL FORM ───
  document.getElementById('emailForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ref = document.querySelector('[data-action="email"]')?.dataset.ref;
    await postAction(ref, 'email', {
      subject: fd.get('subject'),
      message: fd.get('message')
    });
  });

  // ─── NOTE FORM ───
  document.getElementById('noteForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ref = document.querySelector('[data-action="note"]')?.dataset.ref;
    await postAction(ref, 'notes', { text: fd.get('text') });
  });

  // ─── CANCEL FORM ───
  document.getElementById('cancelForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ref = document.querySelector('[data-action="cancel"]')?.dataset.ref;
    if (!confirm(`Cancel order ${ref}? This does NOT issue a refund.`)) return;
    await postAction(ref, 'cancel', { reason: fd.get('reason') });
  });

  // ─── EMAIL RESEND ───
  document.querySelectorAll('[data-resend]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.resend;
      btn.disabled = true;
      btn.textContent = 'Sending…';
      const res = await fetch(`/api/admin/emails/${id}/resend`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.ok) {
        btn.textContent = 'Resent';
        setTimeout(() => window.location.reload(), 500);
      } else {
        btn.textContent = 'Resend';
        btn.disabled = false;
        alert(data.error || 'Resend failed.');
      }
    });
  });
})();

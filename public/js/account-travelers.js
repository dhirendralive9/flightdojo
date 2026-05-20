(function() {
  const modal = document.getElementById('travelerModal');
  const modalTitle = document.getElementById('travelerModalTitle');
  const form = document.getElementById('travelerForm');
  const cancelBtn = document.getElementById('travelerCancel');
  const closeBtn = document.getElementById('travelerModalClose');
  const backdrop = document.getElementById('travelerModalBackdrop');
  const addBtn = document.getElementById('addTravelerBtn');
  const grid = document.getElementById('travelersGrid');

  const passportModal = document.getElementById('passportModal');
  const passportForm = document.getElementById('passportForm');
  const passportInput = document.getElementById('passportInput');
  const passportDropArea = document.getElementById('passportDropArea');
  const passportFileName = document.getElementById('passportFileName');
  const passportCancel = document.getElementById('passportCancel');
  const passportClose = document.getElementById('passportModalClose');
  const passportBackdrop = document.getElementById('passportModalBackdrop');

  function showMsg(scope, msg, type) {
    const el = document.querySelector(`[data-msg-for="${scope}"]`);
    if (!el) return;
    el.textContent = msg;
    el.className = 'auth-msg auth-msg-' + (type || 'info');
  }

  function openModal(traveler) {
    if (!modal) return;
    form.reset();
    if (traveler) {
      modalTitle.textContent = 'Edit traveler';
      form.querySelector('[name="id"]').value = traveler._id;
      form.querySelector('[name="title"]').value = traveler.title || 'mr';
      form.querySelector('[name="given_name"]').value = traveler.given_name || '';
      form.querySelector('[name="family_name"]').value = traveler.family_name || '';
      form.querySelector('[name="born_on"]').value = traveler.born_on || '';
      form.querySelector('[name="gender"]').value = traveler.gender || 'm';
      form.querySelector('[name="relationship"]').value = traveler.relationship || 'other';
    } else {
      modalTitle.textContent = 'Add a traveler';
      form.querySelector('[name="id"]').value = '';
    }
    showMsg('traveler', '', 'info');
    modal.style.display = 'flex';
  }
  function closeModal() { if (modal) modal.style.display = 'none'; }

  addBtn?.addEventListener('click', () => openModal(null));
  cancelBtn?.addEventListener('click', closeModal);
  closeBtn?.addEventListener('click', closeModal);
  backdrop?.addEventListener('click', closeModal);

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const id = fd.get('id');
    const body = {
      title: fd.get('title'),
      given_name: fd.get('given_name'),
      family_name: fd.get('family_name'),
      born_on: fd.get('born_on'),
      gender: fd.get('gender'),
      relationship: fd.get('relationship')
    };
    const url = id ? `/api/account/travelers/${id}` : '/api/account/travelers';
    const method = id ? 'PUT' : 'POST';
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        window.location.reload();
      } else {
        showMsg('traveler', data.error || 'Save failed.', 'error');
      }
    } catch (err) {
      showMsg('traveler', 'Network error. Try again.', 'error');
    }
  });

  // Edit + delete buttons
  grid?.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit]');
    const deleteBtn = e.target.closest('[data-delete]');
    const passportUploadBtn = e.target.closest('[data-upload-passport]');
    const passportViewBtn = e.target.closest('[data-view-passport]');
    const passportDeleteBtn = e.target.closest('[data-delete-passport]');

    if (editBtn) {
      const id = editBtn.dataset.edit;
      const res = await fetch('/api/account/travelers');
      const data = await res.json();
      const t = (data.travelers || []).find(x => x._id === id);
      if (t) openModal(t);
    } else if (deleteBtn) {
      const id = deleteBtn.dataset.delete;
      if (!confirm('Remove this traveler? Any passport copy attached will become unassigned.')) return;
      const res = await fetch(`/api/account/travelers/${id}`, { method: 'DELETE' });
      if (res.ok) window.location.reload();
    } else if (passportUploadBtn) {
      const id = passportUploadBtn.dataset.uploadPassport;
      openPassportModal(id);
    } else if (passportDeleteBtn) {
      const id = passportDeleteBtn.dataset.deletePassport;
      if (!confirm('Remove this passport file?')) return;
      const res = await fetch(`/api/account/passports/${id}`, { method: 'DELETE' });
      if (res.ok) loadPassports();
    }
  });

  // ─── PASSPORT MODAL ───
  function openPassportModal(travelerId) {
    if (!passportModal) return;
    passportForm.reset();
    passportForm.querySelector('[name="traveler_id"]').value = travelerId || '';
    passportFileName.textContent = '';
    showMsg('passport', '', 'info');
    passportModal.style.display = 'flex';
  }
  function closePassportModal() { if (passportModal) passportModal.style.display = 'none'; }

  passportCancel?.addEventListener('click', closePassportModal);
  passportClose?.addEventListener('click', closePassportModal);
  passportBackdrop?.addEventListener('click', closePassportModal);

  passportDropArea?.addEventListener('click', () => passportInput.click());
  passportInput?.addEventListener('change', () => {
    const f = passportInput.files?.[0];
    if (f) {
      passportFileName.textContent = `Selected: ${f.name} (${(f.size / 1024).toFixed(0)} KB)`;
    }
  });

  // Drag and drop
  ['dragenter', 'dragover'].forEach(ev =>
    passportDropArea?.addEventListener(ev, (e) => {
      e.preventDefault();
      passportDropArea.classList.add('drag-active');
    })
  );
  ['dragleave', 'drop'].forEach(ev =>
    passportDropArea?.addEventListener(ev, (e) => {
      e.preventDefault();
      passportDropArea.classList.remove('drag-active');
    })
  );
  passportDropArea?.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.[0]) {
      passportInput.files = e.dataTransfer.files;
      passportFileName.textContent = `Selected: ${e.dataTransfer.files[0].name}`;
    }
  });

  passportForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(passportForm);
    if (!passportInput.files?.[0]) {
      showMsg('passport', 'Please choose a file first.', 'error');
      return;
    }
    try {
      const res = await fetch('/api/account/passports', { method: 'POST', body: fd });
      const data = await res.json();
      if (res.ok && data.ok) {
        closePassportModal();
        loadPassports();
      } else {
        showMsg('passport', data.error || 'Upload failed.', 'error');
      }
    } catch (err) {
      showMsg('passport', 'Network error.', 'error');
    }
  });

  // ─── LOAD PASSPORTS PER TRAVELER ───
  async function loadPassports() {
    if (!grid) return;
    let passports = [];
    try {
      const res = await fetch('/api/account/passports');
      const data = await res.json();
      passports = data.passports || [];
    } catch (err) { return; }

    document.querySelectorAll('[data-passport-state]').forEach(el => {
      const travelerId = el.dataset.passportState;
      const matched = passports.filter(p => p.traveler_id === travelerId);
      if (matched.length === 0) {
        el.innerHTML = `
          <span class="traveler-passport-empty">None on file.</span>
          <button class="traveler-passport-action" data-upload-passport="${travelerId}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
            Upload
          </button>
        `;
      } else {
        el.innerHTML = matched.map(p => `
          <div class="traveler-passport-row">
            <span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ${escapeHtml(p.filename)}</span>
            <span class="traveler-passport-actions">
              <a href="/account/passports/${p._id}/file" target="_blank" rel="noopener">View</a>
              <button data-delete-passport="${p._id}">Remove</button>
            </span>
          </div>
        `).join('');
      }
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  if (grid) loadPassports();
})();

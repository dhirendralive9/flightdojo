(function() {
  function showMsg(scope, msg, type) {
    const el = document.querySelector(`[data-msg-for="${scope}"]`);
    if (!el) return;
    el.textContent = msg;
    el.className = 'auth-msg auth-msg-' + (type || 'info');
  }
  function openModal(id) { const m = document.getElementById(id); if (m) m.style.display = 'flex'; }
  function closeModal(id) { const m = document.getElementById(id); if (m) m.style.display = 'none'; }

  // ─── CREATE GROUP ───
  const addBtn = document.getElementById('addGroupBtn');
  addBtn?.addEventListener('click', () => openModal('groupModal'));
  document.getElementById('groupCancel')?.addEventListener('click', () => closeModal('groupModal'));
  document.getElementById('groupModalClose')?.addEventListener('click', () => closeModal('groupModal'));
  document.getElementById('groupModalBackdrop')?.addEventListener('click', () => closeModal('groupModal'));

  document.getElementById('groupForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await fetch('/api/account/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fd.get('name'), icon: fd.get('icon') })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        window.location.href = '/account/groups/' + data.id;
      } else {
        showMsg('group', data.error || 'Could not create group.', 'error');
      }
    } catch (err) {
      showMsg('group', 'Network error.', 'error');
    }
  });

  // ─── INVITE MEMBER ───
  const inviteBtn = document.getElementById('inviteMemberBtn');
  inviteBtn?.addEventListener('click', () => openModal('inviteModal'));
  document.getElementById('inviteCancel')?.addEventListener('click', () => closeModal('inviteModal'));
  document.getElementById('inviteModalClose')?.addEventListener('click', () => closeModal('inviteModal'));
  document.getElementById('inviteModalBackdrop')?.addEventListener('click', () => closeModal('inviteModal'));

  document.getElementById('inviteForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const groupId = form.dataset.groupId;
    const fd = new FormData(form);
    try {
      const res = await fetch(`/api/account/groups/${groupId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: fd.get('email'), role: fd.get('role') })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        showMsg('invite', 'Invitation sent.', 'success');
        setTimeout(() => window.location.reload(), 800);
      } else {
        showMsg('invite', data.error || 'Could not send invite.', 'error');
      }
    } catch (err) {
      showMsg('invite', 'Network error.', 'error');
    }
  });

  // ─── DELETE GROUP ───
  document.getElementById('deleteGroupBtn')?.addEventListener('click', async (e) => {
    if (!confirm('Delete this group? Members will lose access. Trips themselves remain owned by whoever booked them.')) return;
    const id = e.currentTarget.dataset.groupId;
    const res = await fetch(`/api/account/groups/${id}`, { method: 'DELETE' });
    if (res.ok) window.location.href = '/account/groups';
  });

  // ─── REMOVE MEMBER ───
  document.querySelectorAll('[data-remove-member]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this member from the group?')) return;
      const memberId = btn.dataset.removeMember;
      const groupId = btn.dataset.groupId;
      const res = await fetch(`/api/account/groups/${groupId}/members/${memberId}`, { method: 'DELETE' });
      if (res.ok) window.location.reload();
    });
  });

  // ─── REVOKE INVITE ───
  document.querySelectorAll('[data-revoke-invite]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Revoke this pending invitation?')) return;
      const inviteId = btn.dataset.revokeInvite;
      const groupId = btn.dataset.groupId;
      const res = await fetch(`/api/account/groups/${groupId}/invites/${inviteId}`, { method: 'DELETE' });
      if (res.ok) window.location.reload();
    });
  });
})();

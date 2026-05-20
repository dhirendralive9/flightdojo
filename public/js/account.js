(function() {
  function showMsg(form, msg, type) {
    const tab = form.dataset.tabForm;
    const target = tab
      ? form.querySelector(`[data-msg-for="${tab}"]`)
      : form.querySelector('.auth-msg');
    if (!target) return;
    target.textContent = msg;
    target.className = 'auth-msg auth-msg-' + (type || 'info');
  }

  function lockBtn(btn, label) {
    if (!btn) return null;
    const prev = btn.querySelector('.auth-submit-label')?.textContent || btn.textContent;
    if (btn.querySelector('.auth-submit-label')) {
      btn.querySelector('.auth-submit-label').textContent = label || 'Working…';
    } else {
      btn.textContent = label || 'Working…';
    }
    btn.disabled = true;
    return () => {
      if (btn.querySelector('.auth-submit-label')) {
        btn.querySelector('.auth-submit-label').textContent = prev;
      } else {
        btn.textContent = prev;
      }
      btn.disabled = false;
    };
  }

  async function postJSON(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    let body;
    try { body = await res.json(); } catch { body = {}; }
    return { ok: res.ok, status: res.status, body };
  }

  // ─── LOGIN PAGE: tab switcher ───
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('[data-tab-form]').forEach(f => {
        f.style.display = f.dataset.tabForm === target ? '' : 'none';
      });
    });
  });

  // ─── LOGIN form ───
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(loginForm);
      const btn = loginForm.querySelector('button[type="submit"]');
      const unlock = lockBtn(btn, 'Signing in…');
      const { ok, body } = await postJSON('/api/account/login', {
        email: fd.get('email'),
        password: fd.get('password'),
        next: fd.get('next') || ''
      });
      if (ok && body.ok) {
        window.location.href = body.redirect || '/account';
      } else {
        showMsg(loginForm, body.error || 'Sign in failed.', 'error');
        unlock();
      }
    });
  }

  // ─── MAGIC link form ───
  const magicForm = document.getElementById('magicForm');
  if (magicForm) {
    magicForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(magicForm);
      const btn = magicForm.querySelector('button[type="submit"]');
      const unlock = lockBtn(btn, 'Sending…');
      const { ok, body } = await postJSON('/api/account/magic-link', { email: fd.get('email') });
      if (ok) {
        showMsg(magicForm, 'Check your email. The link expires in 15 minutes.', 'success');
        magicForm.querySelector('input[name="email"]').value = '';
      } else {
        showMsg(magicForm, body.error || 'Could not send link.', 'error');
      }
      unlock();
    });
  }

  // ─── SIGNUP form ───
  const signupForm = document.getElementById('signupForm');
  if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(signupForm);
      const btn = signupForm.querySelector('button[type="submit"]');
      const unlock = lockBtn(btn, 'Creating account…');
      const { ok, body } = await postJSON('/api/account/signup', {
        email: fd.get('email'),
        password: fd.get('password'),
        name: fd.get('name') || '',
        next: fd.get('next') || ''
      });
      if (ok && body.ok) {
        window.location.href = body.redirect || '/account';
      } else {
        showMsg(signupForm, body.error || 'Could not create account.', 'error');
        unlock();
      }
    });
  }

  // ─── FORGOT password form ───
  const forgotForm = document.getElementById('forgotForm');
  if (forgotForm) {
    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(forgotForm);
      const btn = forgotForm.querySelector('button[type="submit"]');
      const unlock = lockBtn(btn, 'Sending…');
      await postJSON('/api/account/forgot', { email: fd.get('email') });
      showMsg(forgotForm, 'If that email is registered, you\'ll receive a reset link shortly.', 'success');
      unlock();
    });
  }

  // ─── RESET password form ───
  const resetForm = document.getElementById('resetForm');
  if (resetForm) {
    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(resetForm);
      const btn = resetForm.querySelector('button[type="submit"]');
      const unlock = lockBtn(btn, 'Saving…');
      const { ok, body } = await postJSON('/api/account/reset/' + encodeURIComponent(resetForm.dataset.token), {
        password: fd.get('password'),
        password_confirm: fd.get('password_confirm')
      });
      if (ok && body.ok) {
        window.location.href = body.redirect || '/account';
      } else {
        showMsg(resetForm, body.error || 'Could not reset password.', 'error');
        unlock();
      }
    });
  }

  // ─── SETTINGS forms ───
  const profileForm = document.getElementById('profileForm');
  if (profileForm) {
    profileForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(profileForm);
      const btn = profileForm.querySelector('button[type="submit"]');
      const unlock = lockBtn(btn, 'Saving…');
      const { ok, body } = await postJSON('/api/account/settings', {
        name: fd.get('name'),
        phone: fd.get('phone')
      });
      showMsg(profileForm, ok ? 'Saved.' : (body.error || 'Save failed.'), ok ? 'success' : 'error');
      unlock();
    });
  }

  const billingForm = document.getElementById('billingForm');
  if (billingForm) {
    billingForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(billingForm);
      const btn = billingForm.querySelector('button[type="submit"]');
      const unlock = lockBtn(btn, 'Saving…');
      const { ok, body } = await postJSON('/api/account/settings', {
        default_billing: {
          name: fd.get('name'),
          company: fd.get('company'),
          country: fd.get('country'),
          country_name: fd.get('country_name'),
          line1: fd.get('line1'),
          line2: fd.get('line2'),
          city: fd.get('city'),
          state: fd.get('state'),
          postal_code: fd.get('postal_code')
        }
      });
      showMsg(billingForm, ok ? 'Saved.' : (body.error || 'Save failed.'), ok ? 'success' : 'error');
      unlock();
    });
  }

  const passwordForm = document.getElementById('passwordForm');
  if (passwordForm) {
    passwordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(passwordForm);
      const btn = passwordForm.querySelector('button[type="submit"]');
      const unlock = lockBtn(btn, 'Saving…');
      const { ok, body } = await postJSON('/api/account/change-password', {
        current_password: fd.get('current_password') || '',
        new_password: fd.get('new_password'),
        new_password_confirm: fd.get('new_password_confirm')
      });
      if (ok) {
        passwordForm.reset();
        showMsg(passwordForm, 'Password updated.', 'success');
      } else {
        showMsg(passwordForm, body.error || 'Could not update password.', 'error');
      }
      unlock();
    });
  }

  // ─── INLINE SIGNUP on booking success page ───
  const inlineSignupForm = document.getElementById('inlineSignupForm');
  if (inlineSignupForm) {
    inlineSignupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(inlineSignupForm);
      const password = fd.get('password');
      const confirm = fd.get('password_confirm');
      if (password !== confirm) {
        showMsg(inlineSignupForm, 'Passwords do not match.', 'error');
        return;
      }
      const btn = inlineSignupForm.querySelector('button[type="submit"]');
      const unlock = lockBtn(btn, 'Creating account…');
      const { ok, body } = await postJSON('/api/account/signup', {
        email: fd.get('email'),
        password: password,
        name: fd.get('name') || ''
      });
      if (ok && body.ok) {
        // Hide signup card, show success card
        document.getElementById('inlineSignupCard').style.display = 'none';
        document.getElementById('inlineSignupSuccess').style.display = 'block';
        document.getElementById('inlineSignupLinkedCount').textContent = body.linked_orders || 1;
      } else if (body.existing) {
        showMsg(inlineSignupForm, 'An account with this email already exists. Sign in instead.', 'error');
        unlock();
      } else {
        showMsg(inlineSignupForm, body.error || 'Could not create account.', 'error');
        unlock();
      }
    });
  }
})();

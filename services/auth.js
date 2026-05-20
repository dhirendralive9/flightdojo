const User = require('../models/User');
const Order = require('../models/Order');

// On signup or any new login, link all Orders matching this user's email
// to the user record. This means past bookings appear in the dashboard
// the moment they create an account.
async function linkOrdersToUser(user) {
  if (!user || !user.email) return { linked: 0 };
  try {
    const result = await Order.updateMany(
      { contact_email: user.email.toLowerCase(), user_id: null },
      { $set: { user_id: user._id } }
    );
    return { linked: result.modifiedCount || 0 };
  } catch (err) {
    console.warn('linkOrdersToUser failed:', err.message);
    return { linked: 0, error: err.message };
  }
}

async function signupWithPassword({ email, password, name, phone }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: 'Please provide a valid email address.' };
  }
  if (!password || password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' };
  }

  const existing = await User.findOne({ email });
  if (existing) {
    // If user exists but has no password yet (magic-link only), set one and log in
    if (!existing.password_hash) {
      await existing.setPassword(password);
      existing.name = existing.name || name || '';
      existing.phone = existing.phone || phone || '';
      existing.last_login_at = new Date();
      existing.login_count += 1;
      await existing.save();
      const linkResult = await linkOrdersToUser(existing);
      return { ok: true, user: existing, linked_orders: linkResult.linked, is_new: false };
    }
    return { ok: false, error: 'An account with this email already exists. Try logging in or resetting your password.', existing: true };
  }

  const user = new User({ email, name: name || '', phone: phone || '' });
  await user.setPassword(password);
  user.last_login_at = new Date();
  user.login_count = 1;
  await user.save();

  const linkResult = await linkOrdersToUser(user);
  return { ok: true, user, linked_orders: linkResult.linked, is_new: true };
}

async function loginWithPassword({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  const user = await User.findOne({ email });
  if (!user) return { ok: false, error: 'No account with that email.' };
  if (!user.password_hash) {
    return { ok: false, error: 'This account uses magic-link login. Check your email for a sign-in link.' };
  }
  const valid = await user.checkPassword(password);
  if (!valid) return { ok: false, error: 'Incorrect password.' };

  user.last_login_at = new Date();
  user.login_count += 1;
  await user.save();
  // Re-link in case there are new orders since last login
  await linkOrdersToUser(user);
  return { ok: true, user };
}

// Generate (or upsert) a user and issue a magic-link token.
// Returns the plaintext token — caller emails it.
async function startMagicLink({ email, name }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: 'Please provide a valid email address.' };
  }
  let user = await User.findOne({ email });
  let isNewUser = false;
  if (!user) {
    user = new User({ email, name: name || '' });
    isNewUser = true;
  }
  const token = user.generateMagicLink(15); // 15 min TTL
  await user.save();
  return { ok: true, token, user, isNewUser };
}

async function consumeMagicLink(rawToken) {
  // Without knowing which user, we have to iterate. For a production system at
  // scale you'd index by hashed token, but for now linear is fine — magic
  // tokens are short-lived and rare.
  const crypto = require('crypto');
  const hashed = crypto.createHash('sha256').update(rawToken).digest('hex');
  const user = await User.findOne({ 'magic_tokens.token_hash': hashed });
  if (!user) return { ok: false, error: 'Invalid or expired link.' };
  if (!user.consumeMagicLink(rawToken)) {
    return { ok: false, error: 'This link has expired or already been used.' };
  }
  user.last_login_at = new Date();
  user.login_count += 1;
  if (!user.email_verified_at) user.email_verified_at = new Date();
  await user.save();
  await linkOrdersToUser(user);
  return { ok: true, user };
}

async function startPasswordReset({ email }) {
  email = String(email || '').trim().toLowerCase();
  const user = await User.findOne({ email });
  // Don't reveal whether the email exists — always pretend success
  if (!user) return { ok: true, token: null, user: null };
  const token = user.generateResetToken(60);
  await user.save();
  return { ok: true, token, user };
}

async function consumePasswordReset(rawToken, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' };
  }
  const crypto = require('crypto');
  const hashed = crypto.createHash('sha256').update(rawToken).digest('hex');
  const user = await User.findOne({ 'reset_tokens.token_hash': hashed });
  if (!user) return { ok: false, error: 'Invalid or expired reset link.' };
  if (!user.consumeResetToken(rawToken)) {
    return { ok: false, error: 'This reset link has expired or already been used.' };
  }
  await user.setPassword(newPassword);
  await user.save();
  return { ok: true, user };
}

// ─── Middleware ───
function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'auth_required' });
    }
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

// Gate admin routes. Must be logged in AND have is_admin=true.
function requireAdmin(req, res, next) {
  if (!req.user) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'auth_required' });
    }
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  if (!req.user.is_admin) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'admin_required' });
    }
    return res.status(403).render('404', { title: 'Forbidden — FlightDojo' });
  }
  // Track last-seen for admin
  req.user.admin_last_seen_at = new Date();
  req.user.save().catch(() => {});
  next();
}

// Role-gating helper for narrower access (used inside admin routes).
// Owner can do everything, manager can do most things, agent does daily ops, viewer is read-only.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user?.is_admin) return res.status(403).json({ error: 'admin_required' });
    if (roles.length === 0) return next();
    const role = req.user.admin_role || 'agent';
    if (role === 'owner' || roles.includes(role)) return next();
    return res.status(403).json({ error: `requires_role: ${roles.join(' or ')}` });
  };
}

// Load the current user (if any) into res.locals.user for use in templates.
// Doesn't enforce auth — just attaches when present.
async function attachUser(req, res, next) {
  if (req.session?.userId) {
    try {
      const user = await User.findById(req.session.userId);
      if (user) {
        req.user = user;
        res.locals.user = user.toSafeJSON();
      }
    } catch (e) { /* session points to a missing user; clear it */
      req.session.destroy(() => {});
    }
  }
  next();
}

module.exports = {
  signupWithPassword,
  loginWithPassword,
  startMagicLink,
  consumeMagicLink,
  startPasswordReset,
  consumePasswordReset,
  linkOrdersToUser,
  requireAuth,
  requireAdmin,
  requireRole,
  attachUser
};

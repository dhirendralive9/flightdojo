// Boots a designated admin account from environment variables.
// Call once after MongoDB is connected. Idempotent and safe to re-run.
//
// Triggered by setting in .env:
//   BOOTSTRAP_ADMIN_EMAIL=you@example.com
//   BOOTSTRAP_ADMIN_PASSWORD=at-least-8-chars
//
// On every boot:
//   - If user doesn't exist → create it with the password and admin flag
//   - If user exists without admin → grant admin
//   - If BOOTSTRAP_ADMIN_RESET_PASSWORD=1 → reset password to what's in .env
//     (otherwise password is left alone for existing users)
//
// Setting up a fresh server:
//   1. Add the two env vars
//   2. Restart the server
//   3. Log in normally with that email + password
//   4. (Optional) Remove BOOTSTRAP_ADMIN_PASSWORD from .env after first login
//      and restart again — admin flag persists in DB.

const User = require('../models/User');

async function bootstrapAdminFromEnv() {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  const role = process.env.BOOTSTRAP_ADMIN_ROLE || 'owner';
  const resetPassword = process.env.BOOTSTRAP_ADMIN_RESET_PASSWORD === '1';

  if (!email) return;

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.warn(`👤 ✗ BOOTSTRAP_ADMIN_EMAIL "${email}" is not a valid email — skipping bootstrap`);
    return;
  }

  if (password && password.length < 8) {
    console.warn(`👤 ✗ BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters — skipping bootstrap`);
    return;
  }

  try {
    let user = await User.findOne({ email });
    let created = false;
    let updated = [];

    if (!user) {
      if (!password) {
        console.warn(`👤 ✗ User ${email} doesn't exist and no BOOTSTRAP_ADMIN_PASSWORD set — cannot create. Skipping.`);
        return;
      }
      user = new User({ email, name: email.split('@')[0] });
      await user.setPassword(password);
      user.is_admin = true;
      user.admin_role = role;
      user.email_verified_at = new Date();
      await user.save();
      console.log(`👤 ✓ Bootstrap admin CREATED: ${email} (role: ${role})`);
      console.log(`   ⚠  IMPORTANT: After your first login, you can leave BOOTSTRAP_ADMIN_PASSWORD in .env`);
      console.log(`      to keep the password in sync, OR remove it (admin flag persists in DB).`);
      return;
    }

    // User exists — grant admin if not already
    if (!user.is_admin) {
      user.is_admin = true;
      updated.push('is_admin=true');
    }
    if (user.admin_role !== role) {
      user.admin_role = role;
      updated.push(`admin_role=${role}`);
    }
    // Optionally reset password
    if (password && resetPassword) {
      await user.setPassword(password);
      updated.push('password reset');
    } else if (password && !user.password_hash) {
      // User exists but has no password (e.g. magic-link only) — set one from env
      await user.setPassword(password);
      updated.push('password set (was magic-link only)');
    }
    if (updated.length > 0) {
      await user.save();
      console.log(`👤 ✓ Bootstrap admin UPDATED: ${email} — ${updated.join(', ')}`);
    } else {
      console.log(`👤 ✓ Bootstrap admin verified: ${email} (already admin, no changes needed)`);
    }
  } catch (err) {
    console.error(`👤 ✗ Bootstrap admin failed for ${email}:`, err.message);
  }
}

module.exports = { bootstrapAdminFromEnv };

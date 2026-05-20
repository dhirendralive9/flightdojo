#!/usr/bin/env node
// Diagnostic tool: check the state of a user account.
// Tells you whether they exist, have a password set, are admin, etc.
//
// Usage:
//   node scripts/check-user.js you@example.com
//
// Optional second argument: a password to verify against.
//   node scripts/check-user.js you@example.com "my-password"

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const email = (process.argv[2] || '').trim().toLowerCase();
const testPassword = process.argv[3] || null;

if (!email) {
  console.error('Usage: node scripts/check-user.js <email> [password]');
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/flightdojo');
    console.log(`Connected to MongoDB.\n`);

    const user = await User.findOne({ email });
    if (!user) {
      console.log(`✗ No user with email: ${email}`);
      console.log(`\nTo create this user as admin, add to .env:`);
      console.log(`  BOOTSTRAP_ADMIN_EMAIL=${email}`);
      console.log(`  BOOTSTRAP_ADMIN_PASSWORD=at-least-8-chars`);
      console.log(`Then restart the server.\n`);
      process.exit(0);
    }

    console.log(`✓ User found: ${email}`);
    console.log(`  _id:               ${user._id}`);
    console.log(`  Name:              ${user.name || '(none)'}`);
    console.log(`  Phone:             ${user.phone || '(none)'}`);
    console.log(`  Created:           ${user.createdAt}`);
    console.log(`  Email verified:    ${user.email_verified_at ? 'YES' : 'no'}`);
    console.log(`  Password set:      ${user.password_hash ? 'YES' : 'NO (magic-link only)'}`);
    console.log(`  Last login:        ${user.last_login_at || '(never)'}`);
    console.log(`  Login count:       ${user.login_count || 0}`);
    console.log(`  Admin:             ${user.is_admin ? `YES (role: ${user.admin_role || 'agent'})` : 'no'}`);
    console.log(`  Referral code:     ${user.referral_code || '(none)'}`);
    console.log(`  Saved travelers:   ${(user.saved_travelers || []).length}`);
    console.log(`  Active credits:    ${(user.credits || []).filter(c => !c.used_at).length}`);

    if (testPassword) {
      console.log(`\nTesting password match…`);
      if (!user.password_hash) {
        console.log(`✗ User has no password set — cannot verify`);
      } else {
        const ok = await user.checkPassword(testPassword);
        console.log(ok ? `✓ Password is CORRECT` : `✗ Password does NOT match`);
      }
    }

    process.exit(0);
  } catch (err) {
    console.error(`Error:`, err.message);
    process.exit(1);
  }
})();

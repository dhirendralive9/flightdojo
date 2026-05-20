const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  password_hash: { type: String, default: null },   // null = magic-link-only user
  name: { type: String, default: '' },
  phone: { type: String, default: '' },

  // Default billing address — autofilled on next booking
  default_billing: {
    name: String,
    company: String,
    country: String,
    country_name: String,
    line1: String,
    line2: String,
    city: String,
    state: String,
    postal_code: String,
    phone: String
  },

  // Saved traveler profiles (passenger data for repeat trips)
  saved_travelers: [{
    title: String,
    given_name: String,
    family_name: String,
    born_on: String,
    gender: String,
    relationship: String  // e.g. 'self', 'spouse', 'child'
  }],

  // Email verification (we don't enforce verification today, but track it)
  email_verified_at: { type: Date, default: null },

  // Magic-link tokens (one user can have multiple active)
  magic_tokens: [{
    token_hash: String,
    expires_at: Date,
    used_at: Date
  }],

  // Password reset tokens
  reset_tokens: [{
    token_hash: String,
    expires_at: Date,
    used_at: Date
  }],

  last_login_at: Date,
  login_count: { type: Number, default: 0 },

  // ─── REFERRALS ───
  // Auto-generated unique code (e.g. "DHIR-7K2X"). Set in pre-save hook below.
  referral_code: { type: String, unique: true, sparse: true, index: true },
  // Who referred this user (set on signup from ?ref= cookie)
  referred_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  // Counter — how many people did this user successfully refer (i.e. they signed up)
  referrals_count: { type: Number, default: 0 },

  // ─── CREDITS ───
  // Discount-balance in account currency (USD by default). Earned via referrals,
  // applied to next booking. Stored as a fraction (e.g. 0.05 = 5%) per credit entry.
  credits: [{
    kind: { type: String, enum: ['referral_referrer', 'referral_referee', 'manual', 'compensation'] },
    percent_off: Number,           // e.g. 0.05 for 5%. Capped per booking.
    fixed_amount: Number,           // OR a fixed amount (USD) — leave 0 if using percent
    currency: { type: String, default: 'USD' },
    earned_from_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    earned_from_order_ref: String,
    earned_at: { type: Date, default: Date.now },
    used_at: Date,
    used_on_order_ref: String,
    note: String
  }]
}, { timestamps: true });

// Generate a referral code on first save
function generateReferralCode(seed) {
  const tail = require('crypto').randomBytes(2).toString('hex').toUpperCase();
  const head = (seed || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'FLY';
  return `${head}-${tail}`;
}

userSchema.pre('save', async function(next) {
  if (!this.referral_code) {
    // Use first 4 chars of email local-part as head, then random 4 hex
    const localPart = (this.email || '').split('@')[0] || 'fly';
    let attempts = 0;
    while (attempts < 5) {
      const code = generateReferralCode(localPart);
      // Check for collision
      const exists = await this.constructor.findOne({ referral_code: code });
      if (!exists) {
        this.referral_code = code;
        break;
      }
      attempts++;
    }
    if (!this.referral_code) {
      // Last-resort fully random
      this.referral_code = require('crypto').randomBytes(5).toString('hex').toUpperCase();
    }
  }
  next();
});

// Convenience: get unused credits sum (percent_off — caller picks the highest)
userSchema.methods.getActiveCredits = function() {
  return (this.credits || []).filter(c => !c.used_at);
};

// Find the best applicable discount for a booking total
userSchema.methods.bestDiscountFor = function(bookingAmount) {
  const active = this.getActiveCredits();
  if (active.length === 0) return null;
  // Calculate discount value for each, return highest
  let best = null;
  for (const credit of active) {
    let amount = 0;
    if (credit.percent_off) {
      amount = bookingAmount * credit.percent_off;
    } else if (credit.fixed_amount) {
      amount = Math.min(credit.fixed_amount, bookingAmount);
    }
    if (!best || amount > best.amount) {
      best = { credit, amount, percent_off: credit.percent_off, fixed_amount: credit.fixed_amount };
    }
  }
  return best;
};

// ─── Password helpers ───
userSchema.methods.setPassword = async function(plain) {
  if (!plain || plain.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  this.password_hash = await bcrypt.hash(plain, 12);
};

userSchema.methods.checkPassword = async function(plain) {
  if (!this.password_hash) return false;
  return bcrypt.compare(plain, this.password_hash);
};

// ─── Token helpers (one-time use, short-lived) ───
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

userSchema.methods.generateMagicLink = function(ttlMinutes = 15) {
  const token = crypto.randomBytes(32).toString('hex');
  this.magic_tokens.push({
    token_hash: hashToken(token),
    expires_at: new Date(Date.now() + ttlMinutes * 60 * 1000),
    used_at: null
  });
  // Keep only the last 5 active tokens to bound storage
  this.magic_tokens = this.magic_tokens.slice(-5);
  return token; // returned in plaintext ONCE
};

userSchema.methods.consumeMagicLink = function(token) {
  const hashed = hashToken(token);
  const match = this.magic_tokens.find(t =>
    t.token_hash === hashed &&
    !t.used_at &&
    t.expires_at > new Date()
  );
  if (!match) return false;
  match.used_at = new Date();
  return true;
};

userSchema.methods.generateResetToken = function(ttlMinutes = 60) {
  const token = crypto.randomBytes(32).toString('hex');
  this.reset_tokens.push({
    token_hash: hashToken(token),
    expires_at: new Date(Date.now() + ttlMinutes * 60 * 1000),
    used_at: null
  });
  this.reset_tokens = this.reset_tokens.slice(-5);
  return token;
};

userSchema.methods.consumeResetToken = function(token) {
  const hashed = hashToken(token);
  const match = this.reset_tokens.find(t =>
    t.token_hash === hashed &&
    !t.used_at &&
    t.expires_at > new Date()
  );
  if (!match) return false;
  match.used_at = new Date();
  return true;
};

// Don't ever serialise the password hash
userSchema.methods.toSafeJSON = function() {
  return {
    id: this._id,
    email: this.email,
    name: this.name,
    phone: this.phone,
    default_billing: this.default_billing,
    saved_travelers: this.saved_travelers,
    email_verified_at: this.email_verified_at,
    last_login_at: this.last_login_at,
    createdAt: this.createdAt,
    referral_code: this.referral_code,
    referred_by: this.referred_by,
    referrals_count: this.referrals_count,
    credits_active_count: (this.credits || []).filter(c => !c.used_at).length
  };
};

module.exports = mongoose.model('User', userSchema);

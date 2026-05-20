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
  login_count: { type: Number, default: 0 }
}, { timestamps: true });

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
    createdAt: this.createdAt
  };
};

module.exports = mongoose.model('User', userSchema);

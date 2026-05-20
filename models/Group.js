const mongoose = require('mongoose');
const crypto = require('crypto');

const groupSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 80 },
  // Optional emoji or icon shortcut (defaults to 👥 in UI)
  icon: { type: String, default: '👥' },

  // The user who created the group
  owner_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // Active members — users who can view all trips in this group
  members: [{
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: { type: String, enum: ['owner', 'member', 'viewer'], default: 'member' },
    joined_at: { type: Date, default: Date.now }
  }],

  // Pending invites — recipients who don't have an account yet (or do but haven't accepted)
  invites: [{
    email: { type: String, required: true, lowercase: true, trim: true },
    token: { type: String, required: true },       // single-use, sent in email
    invited_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: { type: String, enum: ['member', 'viewer'], default: 'member' },
    invited_at: { type: Date, default: Date.now },
    expires_at: Date,
    accepted_at: Date,
    revoked_at: Date
  }]
}, { timestamps: true });

groupSchema.index({ 'members.user_id': 1 });
groupSchema.index({ 'invites.email': 1, 'invites.accepted_at': 1 });

groupSchema.methods.addInvite = function(email, invitedBy, role = 'member', ttlDays = 14) {
  const token = crypto.randomBytes(24).toString('hex');
  this.invites.push({
    email: String(email).toLowerCase().trim(),
    token,
    invited_by_user_id: invitedBy,
    role,
    expires_at: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000)
  });
  return token;
};

groupSchema.methods.acceptInvite = function(token, userId) {
  const invite = this.invites.find(i =>
    i.token === token &&
    !i.accepted_at &&
    !i.revoked_at &&
    i.expires_at > new Date()
  );
  if (!invite) return false;
  invite.accepted_at = new Date();
  // Add as member if not already
  const already = this.members.find(m => String(m.user_id) === String(userId));
  if (!already) {
    this.members.push({ user_id: userId, role: invite.role });
  }
  return true;
};

module.exports = mongoose.model('Group', groupSchema);

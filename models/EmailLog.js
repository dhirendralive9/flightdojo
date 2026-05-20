const mongoose = require('mongoose');

// Every email we send is logged here. Lets admin see delivery history per user,
// resend failed messages, and audit communications during disputes.
const emailLogSchema = new mongoose.Schema({
  to: { type: String, required: true, index: true, lowercase: true, trim: true },
  from: String,
  subject: { type: String, required: true },
  template: { type: String, index: true },   // e.g. 'booking_confirmation', 'welcome', 'magic_link'

  // Relations (any may be null)
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  order_reference: { type: String, index: true, default: null },

  // SMTP outcome
  status: {
    type: String,
    enum: ['queued', 'accepted', 'rejected', 'failed', 'bounced'],
    default: 'queued',
    index: true
  },
  message_id: String,         // from nodemailer / SMTP
  smtp_response: String,       // from SMTP server, e.g. "250 OK queued as ..."
  error: String,                // error message if failed

  // For resends
  resent_from_log_id: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailLog', default: null },
  resend_count: { type: Number, default: 0 },

  // Captured bodies (truncated) for ops visibility on what was actually sent.
  // We deliberately store these so support can answer "what did the customer
  // see in their email?" — keep them short for privacy + storage.
  preview: String,             // first ~200 chars of text body
}, { timestamps: true });

emailLogSchema.index({ to: 1, createdAt: -1 });
emailLogSchema.index({ order_reference: 1, createdAt: -1 });
emailLogSchema.index({ status: 1, createdAt: -1 });

// Convenience: count rejected/failed in a window
emailLogSchema.statics.recentFailureCount = function(hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  return this.countDocuments({
    status: { $in: ['rejected', 'failed', 'bounced'] },
    createdAt: { $gte: since }
  });
};

module.exports = mongoose.model('EmailLog', emailLogSchema);

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // Visual category — drives the icon + color
  type: {
    type: String,
    enum: [
      'booking_confirmed',    // ✓ payment received
      'ticket_issued',        // ✈ ops issued ticket
      'travel_reminder',      // ⏰ 24h before
      'payment_received',     // 💳 receipt
      'support',              // 💬 ops replied
      'account',              // 👤 settings change, password reset, etc.
      'system'                // generic
    ],
    default: 'system'
  },

  title: { type: String, required: true, maxlength: 140 },
  body: { type: String, default: '', maxlength: 600 },

  // Where clicking the notification takes the user
  link: { type: String, default: null },

  // Optional reference to the related Order
  order_reference: { type: String, default: null, index: true },

  read_at: { type: Date, default: null, index: true },
  dismissed_at: { type: Date, default: null }
}, { timestamps: true });

notificationSchema.index({ user_id: 1, createdAt: -1 });

// Helper: push a notification to a user. Fire-and-forget from anywhere.
notificationSchema.statics.push = async function(userId, payload) {
  if (!userId) return null;
  try {
    return await this.create({ user_id: userId, ...payload });
  } catch (err) {
    console.warn('Notification.push failed:', err.message);
    return null;
  }
};

module.exports = mongoose.model('Notification', notificationSchema);

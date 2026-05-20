const mongoose = require('mongoose');

const savedSearchSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // Search parameters
  origin: { type: String, required: true, uppercase: true },
  destination: { type: String, required: true, uppercase: true },
  depart_date: { type: String, required: true },     // YYYY-MM-DD
  return_date: { type: String, default: null },
  passengers: { type: Number, default: 1, min: 1, max: 9 },
  cabin_class: { type: String, enum: ['economy', 'premium_economy', 'business', 'first'], default: 'economy' },

  // For display in dashboard
  origin_name: String,
  destination_name: String,

  // Price tracking
  baseline_price: Number,           // Set on first save — the price at the time of saving
  baseline_currency: { type: String, default: 'USD' },
  current_price: Number,
  current_currency: String,
  last_checked_at: Date,
  last_offer_id: String,            // Latest Duffel offer ID for one-click booking

  // Alert state
  alert_threshold_percent: { type: Number, default: 0.10 },  // 10% drop triggers alert
  last_alert_sent_at: Date,
  alert_last_price: Number,

  // Status
  active: { type: Boolean, default: true, index: true },
  paused_at: Date,
  archived_at: Date
}, { timestamps: true });

savedSearchSchema.index({ user_id: 1, active: 1, createdAt: -1 });

module.exports = mongoose.model('SavedSearch', savedSearchSchema);

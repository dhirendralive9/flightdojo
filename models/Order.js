const mongoose = require('mongoose');

const passengerSchema = new mongoose.Schema({
  type: { type: String, default: 'adult' },
  title: String,
  given_name: String,
  family_name: String,
  born_on: String,
  email: String,
  phone_number: String,
  gender: String
}, { _id: false });

const segmentSchema = new mongoose.Schema({
  origin: String,
  destination: String,
  carrier: String,
  carrier_iata: String,
  flight_number: String,
  departing_at: String,
  arriving_at: String,
  aircraft: String
}, { _id: false });

const sliceSchema = new mongoose.Schema({
  origin: String,
  origin_name: String,
  destination: String,
  destination_name: String,
  duration: String,
  departure_date: String,
  stops: Number,
  segments: [segmentSchema]
}, { _id: false });

const billingSchema = new mongoose.Schema({
  name: String,                  // Cardholder full name
  email: String,                 // Billing email (often = contact_email)
  company: String,               // Optional company name (for invoice)
  country: { type: String, index: true },  // ISO 3166-1 alpha-2 (e.g. "US", "IN", "GB")
  country_name: String,          // Human-readable for display
  line1: String,                 // Street address
  line2: String,                 // Apt / suite / unit (optional)
  city: String,
  state: String,                 // State / region / province
  postal_code: String,           // ZIP / postal code
  phone: String                  // Optional billing phone (often = contact_phone)
}, { _id: false });

// Customer's seat + bag selections + preference notes for offline ticketing
const addonsSchema = new mongoose.Schema({
  seats: [{
    passenger_index: Number,
    slice_index: Number,
    designator: String,        // e.g. "12A", "23F", or null if not pickable
    amount: String,
    currency: String,
    service_id: String         // Duffel service ID for ops reference
  }],
  seat_preference_notes: String,

  bags: [{
    passenger_index: Number,
    kind: String,              // 'checked' | 'carry_on'
    max_weight_kg: Number,
    quantity: Number,
    amount: String,
    currency: String,
    service_id: String
  }],
  bag_preference_notes: String,

  affiliate_clicks: [{
    partner: String,
    clicked_at: { type: Date, default: Date.now }
  }],

  total_addons_amount: String
}, { _id: false });

const proxyCheckSchema = new mongoose.Schema({
  ip: String,
  risk_score: Number,
  confidence: Number,
  anonymous: Boolean,
  proxy: Boolean,
  vpn: Boolean,
  tor: Boolean,
  hosting: Boolean,
  scraper: Boolean,
  network_type: String,
  asn: String,
  isp: String,
  organisation: String,
  hostname: String,
  country: String,
  region: String,
  city: String,
  operator_name: String,
  operator_services: [String],
  recommendation: String,
  raw: mongoose.Schema.Types.Mixed,
  checked_at: { type: Date, default: Date.now }
}, { _id: false });

const orderSchema = new mongoose.Schema({
  reference: { type: String, unique: true, index: true },
  status: {
    type: String,
    enum: ['pending', 'risk_blocked', 'awaiting_payment', 'paid', 'booked', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },

  // Duffel
  duffel_offer_id: { type: String, index: true },
  duffel_order_id: { type: String, sparse: true, index: true },
  booking_reference: String,

  // Stripe
  stripe_payment_intent_id: { type: String, sparse: true, index: true },
  stripe_payment_status: String,
  stripe_amount: Number,
  stripe_currency: String,
  stripe_payment_method: String,

  // Pricing
  total_amount: String,
  total_currency: String,
  base_amount: String,
  tax_amount: String,

  // Trip snapshot
  carrier: String,
  carrier_iata: String,
  passenger_count: Number,
  slices: [sliceSchema],

  // Passengers
  passengers: [passengerSchema],
  contact_email: { type: String, index: true },
  contact_phone: String,

  // Billing — cardholder address. Stored both here (for our admin + tax + chargeback
  // defense) and on Stripe (for AVS during payment + receipts).
  billing: billingSchema,

  // Add-ons — seats, bags, preference notes, affiliate clicks
  addons: { type: addonsSchema, default: () => ({}) },

  // Security check
  proxy_check: proxyCheckSchema,

  // Booking artifacts
  email_sent_at: Date,
  failure_reason: String
}, { timestamps: true });

orderSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);

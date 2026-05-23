const mongoose = require('mongoose');

// Admin-managed HTML/JS snippets that get injected into the page shell.
//
//   placement: 'header'   → injected at the end of <head>
//              'footer'   → injected just before </body>
//
//   scope:     'all'      → every page
//              'external' → public-facing pages only (matches services/seo.js
//                           NEVER_INDEX_PATHS — everything NOT in that list)
//              'internal' → account/admin/booking/api/etc. (in NEVER_INDEX_PATHS)
//
// Snippets are rendered as raw HTML (the whole point — analytics tags can't be
// escaped). Treat write access as equivalent to full XSS on the site:
//   - Only owner + manager roles can write (see routes/admin-snippets.js)
//   - Every save appends to revisions[] so you can roll back
//   - `active=false` disables without deleting

const revisionSchema = new mongoose.Schema({
  code: { type: String, required: true },
  edited_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  edited_by_email: String,         // denormalized in case user is deleted
  note: String,                    // optional "what changed" message from the editor
  edited_at: { type: Date, default: Date.now }
}, { _id: false });

const codeSnippetSchema = new mongoose.Schema({
  // Friendly name — shown in the admin list. Unique so you can't accidentally
  // create two "Google Analytics" snippets.
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120,
    unique: true,
    index: true
  },

  // Optional longer description so future-you knows what this is for.
  description: { type: String, default: '', maxlength: 500 },

  placement: {
    type: String,
    enum: ['header', 'footer'],
    required: true,
    index: true
  },

  scope: {
    type: String,
    enum: ['all', 'internal', 'external'],
    required: true,
    default: 'all',
    index: true
  },

  // The actual HTML/JS payload. Stored verbatim, rendered as raw HTML.
  // Cap at 64 KB — analytics + chat widgets are typically <2 KB, this leaves
  // plenty of headroom and bounds the size of any cache entry.
  code: { type: String, required: true, maxlength: 65536 },

  active: { type: Boolean, default: true, index: true },

  // Lower = renders first. Ties broken by createdAt ascending.
  priority: { type: Number, default: 100 },

  // Optional path patterns. If empty, the scope alone controls inclusion.
  // - include_paths: snippet only renders on these paths (overrides scope)
  // - exclude_paths: snippet skipped on these paths (in addition to scope)
  // Patterns are simple prefix matches: "/landing" matches "/landing" and
  // "/landing/*". Trailing "*" is implied. Wildcards beyond that are not
  // supported on purpose — admins shouldn't be writing regex in the UI.
  include_paths: [{ type: String, trim: true, maxlength: 200 }],
  exclude_paths: [{ type: String, trim: true, maxlength: 200 }],

  // Audit trail
  created_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  created_by_email: String,
  last_edited_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  last_edited_by_email: String,
  revisions: [revisionSchema]
}, { timestamps: true });

// Useful for the loader query: active + placement, sorted by priority
codeSnippetSchema.index({ active: 1, placement: 1, priority: 1, createdAt: 1 });

// Append a revision and update the last_edited_by fields. Caller still saves.
codeSnippetSchema.methods.recordRevision = function(actor, note) {
  this.revisions.push({
    code: this.code,
    edited_by_user_id: actor?._id || null,
    edited_by_email: actor?.email || null,
    note: note || ''
  });
  // Keep only the last 20 revisions to bound document growth. Snippet bodies
  // can be sizeable; 20 × 64 KB is 1.25 MB, well under Mongo's 16 MB doc limit.
  if (this.revisions.length > 20) {
    this.revisions = this.revisions.slice(-20);
  }
  this.last_edited_by_user_id = actor?._id || null;
  this.last_edited_by_email = actor?.email || null;
};

module.exports = mongoose.model('CodeSnippet', codeSnippetSchema);

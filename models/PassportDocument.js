const mongoose = require('mongoose');
const crypto = require('crypto');

// Symmetric encryption-at-rest for passport documents.
// Uses AES-256-GCM with a key derived from PASSPORT_ENCRYPTION_KEY in .env.
// If no key is configured, files are stored unencrypted (with a warning) —
// fine for dev but you'd want a key in production.

function getEncryptionKey() {
  const raw = process.env.PASSPORT_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) return null;
  // Use SHA-256 to coerce any string into a 32-byte key
  return crypto.createHash('sha256').update(raw).digest();
}

function encryptBuffer(buf) {
  const key = getEncryptionKey();
  if (!key) return { ciphertext: buf, iv: null, tag: null, encrypted: false };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag, encrypted: true };
}

function decryptBuffer(ciphertext, iv, tag) {
  const key = getEncryptionKey();
  if (!key || !iv || !tag) return ciphertext; // wasn't encrypted
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

const passportSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // Linked saved-traveler entry on the User document (by the _id of the
  // saved_travelers subdoc). If null, this passport is "unassigned".
  traveler_id: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

  filename: { type: String, required: true },
  mime_type: { type: String, required: true },
  size_bytes: { type: Number, required: true },

  // Binary content. Either plaintext or encrypted (depending on whether
  // PASSPORT_ENCRYPTION_KEY is configured).
  data: { type: Buffer, required: true },
  iv: { type: Buffer, default: null },
  tag: { type: Buffer, default: null },
  encrypted: { type: Boolean, default: false },

  // OCR placeholder — when we add OCR in the future, parsed passport fields go here
  parsed: {
    given_names: String,
    surname: String,
    document_number: String,
    nationality: String,
    date_of_birth: String,
    sex: String,
    expiry_date: String,
    issuing_country: String
  },
  ocr_processed_at: { type: Date, default: null }
}, { timestamps: true });

passportSchema.statics.encryptBuffer = encryptBuffer;
passportSchema.statics.decryptBuffer = decryptBuffer;

module.exports = mongoose.model('PassportDocument', passportSchema);

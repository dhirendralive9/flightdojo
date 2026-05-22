const nodemailer = require('nodemailer');
const crypto = require('crypto');

const host = process.env.SMTP_HOST;
const port = parseInt(process.env.SMTP_PORT || '587', 10);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = process.env.SMTP_FROM || 'FlightDojo <noreply@flightdojo.it.com>';

// Compute the public, tokenized booking URL for an order. Single source of
// truth — used by every email template so all "View booking" links work
// without login. Caller can override by setting order.public_url.
function publicBookingUrl(order) {
  if (!order || !order.reference) return null;
  if (order.public_url) return order.public_url;
  const baseUrl = (process.env.BASE_URL || 'https://flightdojo.it.com').replace(/\/+$/, '');
  const secret = process.env.SESSION_SECRET || 'flightdojo-dev-secret-CHANGE-IN-PRODUCTION';
  const token = crypto
    .createHmac('sha256', secret)
    .update(`order-view:${order.reference}`)
    .digest('hex')
    .slice(0, 16);
  return `${baseUrl}/booking/${order.reference}?t=${token}`;
}

const configured = host && user && pass && !user.includes('REPLACE_ME');

let transporter = null;
let transporterReady = false;

if (configured) {
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    // Helpful diagnostics
    logger: false,
    debug: false
  });
  transporter.verify((err, success) => {
    if (err) {
      console.error('📬 ✗ SMTP verify FAILED:', err.message);
      console.error('   Host:', host, 'Port:', port, 'User:', user);
      console.error('   Emails will NOT be sent until SMTP is fixed.');
      transporterReady = false;
    } else {
      console.log(`📬 ✓ SMTP transport ready (${host}:${port}, from: ${from})`);
      transporterReady = true;
    }
  });
} else {
  console.warn('⚠  SMTP not configured — emails will be logged to console only');
  console.warn('   Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env');
}

// Lazy-load EmailLog to avoid circular dependency at module load time.
// Mongoose will register the model on first require — we need it on demand.
function getEmailLog() {
  try { return require('../models/EmailLog'); }
  catch (e) { return null; }
}

// Centralized email send that logs every attempt to MongoDB.
// All public mailer functions should call this rather than transporter.sendMail directly.
async function sendAndLog({ to, subject, html, text, headers, replyTo, template, user_id, order_reference, preview }) {
  const EmailLog = getEmailLog();
  let logEntry = null;
  try {
    if (EmailLog) {
      logEntry = await EmailLog.create({
        to, from, subject,
        template: template || null,
        user_id: user_id || null,
        order_reference: order_reference || null,
        status: 'queued',
        preview: (preview || (text || '').replace(/\s+/g, ' ').slice(0, 200))
      });
    }
  } catch (err) { /* DB optional */ }

  if (!transporter) {
    console.log(`───── ${subject} (SMTP not configured) → ${to}`);
    if (logEntry) {
      logEntry.status = 'failed';
      logEntry.error = 'SMTP not configured';
      await logEntry.save().catch(() => {});
    }
    return { ok: false, reason: 'no_transport', logId: logEntry?._id };
  }

  try {
    const info = await transporter.sendMail({
      from, to, subject, html, text,
      replyTo: replyTo || process.env.SMTP_REPLY_TO || 'support@flightdojo.it.com',
      headers: headers || { 'X-Mailer': 'FlightDojo', 'Precedence': 'transactional' }
    });
    console.log(`📬 ✓ ${template || 'email'} accepted by SMTP → ${to} · ${info.messageId}`);

    if (logEntry) {
      const rejected = Array.isArray(info.rejected) && info.rejected.length > 0;
      logEntry.status = rejected ? 'rejected' : 'accepted';
      logEntry.message_id = info.messageId || '';
      logEntry.smtp_response = info.response || '';
      if (rejected) logEntry.error = 'Recipients rejected: ' + info.rejected.join(', ');
      await logEntry.save().catch(() => {});
    }
    return { ok: true, info, logId: logEntry?._id };
  } catch (err) {
    console.error(`📬 ✗ ${template || 'email'} send FAILED → ${to}:`, err.message);
    if (logEntry) {
      logEntry.status = 'failed';
      logEntry.error = err.message;
      logEntry.smtp_response = err.response || '';
      await logEntry.save().catch(() => {});
    }
    return { ok: false, error: err.message, logId: logEntry?._id };
  }
}

// Inline-styled HTML (most email clients strip <style> tags).
// Palette mirrors site: coral #FF5038, charcoal #1a1a1a, parchment #F4F1EB.
function brandedEmail({ subject, preheader, contentBlocks, footerText }) {
  const CORAL = '#FF5038';
  const TEXT = '#1a1a1a';
  const MUTED = '#6b6b6b';
  const BG = '#F4F1EB';
  const SURFACE = '#ffffff';
  const BORDER = '#e3ddd1';

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BG};font-family:'Helvetica Neue',Arial,sans-serif;color:${TEXT};">
<!-- Preheader: rendered in inbox preview, hidden in body. No transparent/invisible
     text tricks that trigger SpamAssassin FONT_INVIS_MSGID. -->
<div style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${SURFACE};border:1px solid ${BORDER};border-radius:6px;overflow:hidden;">

      <!-- Header -->
      <tr><td style="padding:28px 32px;border-bottom:1px solid ${BORDER};background:${SURFACE};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:800;color:${TEXT};letter-spacing:-0.01em;">
              Flight<span style="color:${CORAL};font-style:italic;">Dojo</span>
            </td>
            <td align="right" style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED};font-weight:600;">
              flightdojo.it.com
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- Coral accent strip -->
      <tr><td style="height:3px;background:${CORAL};line-height:3px;font-size:0;">&nbsp;</td></tr>

      <!-- Body -->
      ${contentBlocks}

      <!-- Footer -->
      <tr><td style="padding:28px 32px;background:#fafaf7;border-top:1px solid ${BORDER};">
        <div style="font-size:11px;color:${MUTED};line-height:1.7;letter-spacing:0.03em;">
          ${footerText || ''}
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid ${BORDER};">
            <strong style="color:${TEXT};">Lazarus Consulting LLC</strong><br/>
            Delaware, USA · flightdojo.it.com<br/>
            This is a transactional email regarding your FlightDojo booking.
          </div>
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Plain-text version of the confirmation. Substantively matches the HTML so
// SpamAssassin doesn't flag MPART_ALT_DIFF. Customer sees this if their email
// client only renders plain text (rare but happens).
function buildPlainTextConfirmation(order) {
  const currency = order.total_currency === 'EUR' ? 'EUR ' :
    order.total_currency === 'USD' ? 'USD ' :
    order.total_currency === 'GBP' ? 'GBP ' : (order.total_currency || '') + ' ';
  const total = Math.round(parseFloat(order.total_amount || 0));
  const base = Math.round(parseFloat(order.base_amount || 0));
  const tax = Math.round(parseFloat(order.tax_amount || 0));
  const baseUrl = process.env.BASE_URL || 'https://flightdojo.it.com';
  const firstName = order.passengers?.[0]?.given_name || '';

  const lines = [];
  lines.push('BOOKING CONFIRMED');
  lines.push('=================');
  lines.push('');
  lines.push('Your booking is confirmed.');
  lines.push('');
  lines.push(`Thank you${firstName ? ', ' + firstName : ''}. We've received your booking and payment for the trip below.`);
  lines.push('');
  lines.push('Our team is now issuing your ticket with the airline. You will receive a second email within 2 business hours containing your airline booking reference (PNR), which you will use at check-in. If you do not see it, please check your spam folder or reply to this email.');
  lines.push('');
  lines.push('FLIGHTDOJO ORDER ID');
  lines.push('-------------------');
  lines.push(order.reference);
  lines.push('Quote this number for any support enquiries.');
  lines.push('');
  lines.push('ITINERARY');
  lines.push('---------');
  (order.slices || []).forEach((slice, idx) => {
    lines.push(`${idx === 0 ? 'Outbound' : 'Return'} · ${slice.departure_date || ''}`);
    lines.push(`  ${slice.origin} → ${slice.destination}`);
    if (slice.duration) lines.push(`  Duration: ${slice.duration}`);
    lines.push(`  ${slice.stops === 0 ? 'Direct' : `${slice.stops} stop${slice.stops > 1 ? 's' : ''}`}`);
    lines.push('');
  });

  lines.push('PASSENGERS');
  lines.push('----------');
  (order.passengers || []).forEach(p => {
    const name = [p.title, p.given_name, p.family_name].filter(Boolean).join(' ');
    lines.push(`  ${name}${p.type && p.type !== 'adult' ? ' (' + p.type + ')' : ''}`);
  });
  lines.push('');

  if (order.carrier) {
    lines.push('CARRIER');
    lines.push('-------');
    lines.push(`  ${order.carrier}${order.carrier_iata ? ' (' + order.carrier_iata + ')' : ''}`);
    lines.push('');
  }

  lines.push('PAYMENT');
  lines.push('-------');
  lines.push(`  Base fare:       ${currency}${base}`);
  lines.push(`  Taxes & fees:    ${currency}${tax}`);
  lines.push(`  Total paid:      ${currency}${total}`);
  lines.push('');
  lines.push(`View your booking online: ${publicBookingUrl(order) || (baseUrl + '/booking/' + order.reference)}`);
  lines.push('');
  lines.push('Need help? Reply to this email or visit ' + baseUrl + '/contact');
  lines.push('');
  lines.push('Lazarus Consulting LLC · Delaware, USA · flightdojo.it.com');
  lines.push('This is a transactional email regarding your FlightDojo booking.');

  return lines.join('\n');
}

function bookingConfirmation(order) {
  const CORAL = '#FF5038';
  const TEXT = '#1a1a1a';
  const MUTED = '#6b6b6b';
  const BORDER = '#e3ddd1';
  const SOFT = '#fdf3f1';

  const currency = order.total_currency === 'EUR' ? '€' :
    order.total_currency === 'USD' ? '$' :
    order.total_currency === 'GBP' ? '£' : order.total_currency + ' ';
  const total = Math.round(parseFloat(order.total_amount));

  const slicesHtml = (order.slices || []).map((s, idx) => `
    <tr><td style="padding:18px 0;${idx > 0 ? `border-top:1px dashed ${BORDER};` : ''}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${CORAL};font-weight:700;padding-bottom:8px;">
            ${idx === 0 ? 'Outbound' : 'Return'} · ${escapeHtml(s.departure_date || '')}
          </td>
        </tr>
        <tr>
          <td>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="35%" style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:800;color:${TEXT};line-height:1;">
                  ${escapeHtml(s.origin || '')}
                </td>
                <td width="30%" align="center" style="font-size:11px;color:${MUTED};letter-spacing:0.08em;text-transform:uppercase;font-weight:600;">
                  ${escapeHtml(s.duration || '')}<br/>
                  <span style="color:${CORAL};">→</span><br/>
                  ${s.stops === 0 ? 'Direct' : `${s.stops} stop${s.stops > 1 ? 's' : ''}`}
                </td>
                <td width="35%" align="right" style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:800;color:${TEXT};line-height:1;">
                  ${escapeHtml(s.destination || '')}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>
  `).join('');

  const paxList = (order.passengers || []).map(p => `
    <li style="margin-bottom:4px;">
      ${escapeHtml([p.title, p.given_name, p.family_name].filter(Boolean).join(' '))}
      ${p.type !== 'adult' ? ` <span style="color:${MUTED};">(${escapeHtml(p.type)})</span>` : ''}
    </li>
  `).join('');

  const content = `
    <tr><td style="padding:32px;">
      <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${CORAL};font-weight:700;margin-bottom:8px;">
        Booking Confirmed
      </div>
      <h1 style="margin:0 0 18px 0;font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:800;color:${TEXT};line-height:1.1;">
        Your booking is confirmed.
      </h1>
      <p style="margin:0 0 16px 0;font-size:14px;color:${MUTED};line-height:1.65;">
        Thank you${order.passengers?.[0]?.given_name ? ', ' + escapeHtml(order.passengers[0].given_name) : ''}.
        We've received your booking and payment for the trip below.
      </p>
      <p style="margin:0 0 24px 0;font-size:14px;color:${MUTED};line-height:1.65;">
        Our team is now issuing your ticket with the airline. You'll receive a second email within <strong style="color:${TEXT};">2 business hours</strong> containing your airline booking reference (PNR), which you'll use at check-in. If you don't see it, please check your spam folder or reply to this email.
      </p>

      <div style="background:${SOFT};border-left:3px solid ${CORAL};padding:14px 18px;margin-bottom:24px;">
        <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED};font-weight:600;margin-bottom:4px;">
          FlightDojo Order ID
        </div>
        <div style="font-family:Georgia,serif;font-size:22px;font-weight:800;color:${TEXT};letter-spacing:0.08em;">
          ${escapeHtml(order.reference)}
        </div>
        <div style="font-size:11px;color:${MUTED};margin-top:6px;">
          Quote this number for any support enquiries.
        </div>
      </div>

      <div style="margin-bottom:24px;">
        <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${CORAL};font-weight:700;margin-bottom:12px;">
          Itinerary
        </div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER};border-radius:4px;padding:0 18px;">
          ${slicesHtml}
        </table>
      </div>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          <td width="50%" valign="top" style="padding-right:12px;">
            <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${CORAL};font-weight:700;margin-bottom:10px;">
              Passengers
            </div>
            <ul style="margin:0;padding-left:18px;font-size:13px;color:${TEXT};line-height:1.7;">
              ${paxList}
            </ul>
          </td>
          <td width="50%" valign="top" style="padding-left:12px;">
            <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${CORAL};font-weight:700;margin-bottom:10px;">
              Carrier
            </div>
            <div style="font-size:13px;color:${TEXT};line-height:1.7;">
              ${escapeHtml(order.carrier || 'Carrier TBC')}<br/>
              <span style="color:${MUTED};">${escapeHtml(order.carrier_iata || '')}</span>
            </div>
          </td>
        </tr>
      </table>

      <div style="background:#fafaf7;border:1px solid ${BORDER};border-radius:4px;padding:18px;margin-bottom:24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:13px;color:${MUTED};">Base fare</td>
            <td align="right" style="font-size:13px;color:${TEXT};font-weight:500;">${currency}${Math.round(parseFloat(order.base_amount || 0))}</td>
          </tr>
          <tr>
            <td style="font-size:13px;color:${MUTED};padding-top:6px;">Taxes &amp; fees</td>
            <td align="right" style="font-size:13px;color:${TEXT};font-weight:500;padding-top:6px;">${currency}${Math.round(parseFloat(order.tax_amount || 0))}</td>
          </tr>
          <tr><td colspan="2" style="border-top:1px solid ${BORDER};padding-top:10px;"></td></tr>
          <tr>
            <td style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${TEXT};font-weight:700;">Total paid</td>
            <td align="right" style="font-family:Georgia,serif;font-size:26px;font-weight:800;color:${CORAL};">${currency}${total}</td>
          </tr>
        </table>
      </div>

      <div style="text-align:center;margin:24px 0 8px;">
        <a href="${publicBookingUrl(order) || (escapeHtml(process.env.BASE_URL || 'https://flightdojo.it.com') + '/booking/' + escapeHtml(order.reference))}"
           style="display:inline-block;background:${CORAL};color:#fff;text-decoration:none;font-family:Georgia,serif;font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;padding:14px 28px;border-radius:4px;">
          View booking online →
        </a>
      </div>
    </td></tr>
  `;

  const footer = `
    <strong style="color:${TEXT};">Need help?</strong> Reply to this email or visit
    <a href="${escapeHtml(process.env.BASE_URL || 'https://flightdojo.it.com')}/contact" style="color:${CORAL};text-decoration:none;">flightdojo.it.com/contact</a>.<br/>
    Order ID ${escapeHtml(order.reference)} · Issued ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.
  `;

  return brandedEmail({
    subject: `FlightDojo Booking Confirmed · ${order.booking_reference || order.reference}`,
    preheader: `Your booking ${order.booking_reference || order.reference} is confirmed. Total ${currency}${total}.`,
    contentBlocks: content,
    footerText: footer
  });
}

async function sendBookingConfirmation(order) {
  const html = bookingConfirmation(order);
  const to = order.contact_email;
  if (!to) {
    console.warn('📬 No contact_email on order', order.reference, '— cannot send confirmation');
    return false;
  }

  const plainText = buildPlainTextConfirmation(order);
  const result = await sendAndLog({
    to,
    subject: `Booking Confirmed · ${order.booking_reference || order.reference}`,
    html,
    text: plainText,
    headers: {
      'X-FlightDojo-Order': order.reference,
      'X-Mailer': 'FlightDojo',
      'List-Unsubscribe': `<mailto:unsubscribe@flightdojo.it.com?subject=Unsubscribe-${order.reference}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Auto-Response-Suppress': 'OOF, AutoReply',
      'Precedence': 'transactional'
    },
    template: 'booking_confirmation',
    user_id: order.user_id || null,
    order_reference: order.reference
  });
  return result.ok;
}
// Sent when payment goes through but Duffel rejects the order (so no PNR).
// Customer has been charged — they need to know we're handling it.
function bookingPendingEmail(order, failureReason) {
  const CORAL = '#FF5038';
  const TEXT = '#1a1a1a';
  const MUTED = '#6b6b6b';

  const currency = order.total_currency === 'EUR' ? '€' :
    order.total_currency === 'USD' ? '$' :
    order.total_currency === 'GBP' ? '£' : order.total_currency + ' ';
  const total = Math.round(parseFloat(order.total_amount || 0));

  const content = `
    <tr><td style="padding:32px;">
      <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${CORAL};font-weight:700;margin-bottom:8px;">
        Payment Received · Booking In Progress
      </div>
      <h1 style="margin:0 0 18px 0;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:800;color:${TEXT};line-height:1.15;">
        We have your payment.
      </h1>
      <p style="margin:0 0 20px 0;font-size:14px;color:${MUTED};line-height:1.7;">
        Thank you${order.passengers?.[0]?.given_name ? ', ' + escapeHtml(order.passengers[0].given_name) : ''}. We received your payment of <strong style="color:${TEXT};">${currency}${total}</strong> successfully, but couldn't finalise the airline booking on the first attempt.
      </p>
      <p style="margin:0 0 20px 0;font-size:14px;color:${MUTED};line-height:1.7;">
        <strong style="color:${TEXT};">What happens next:</strong> Our team has been notified and will manually issue your ticket within <strong style="color:${TEXT};">one business hour</strong>. You'll get a separate confirmation email with your PNR as soon as it's done.
      </p>
      <p style="margin:0 0 24px 0;font-size:13px;color:${MUTED};line-height:1.7;">
        <strong style="color:${TEXT};">You have not been charged twice.</strong> No action is needed from you. If you don't hear from us within an hour, please reply to this email or contact support with your order ID below.
      </p>

      <div style="background:#fdf3f1;border-left:3px solid ${CORAL};padding:14px 18px;margin-bottom:20px;">
        <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED};font-weight:700;margin-bottom:6px;">
          Order Reference
        </div>
        <div style="font-family:Georgia,serif;font-size:22px;font-weight:800;color:${TEXT};letter-spacing:0.08em;">
          ${escapeHtml(order.reference)}
        </div>
      </div>

      <div style="text-align:center;margin:20px 0 8px;">
        <a href="${escapeHtml(process.env.BASE_URL || 'https://flightdojo.it.com')}/contact"
           style="display:inline-block;background:${CORAL};color:#fff;text-decoration:none;font-family:Georgia,serif;font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;padding:13px 26px;border-radius:4px;">
          Contact Support →
        </a>
      </div>
    </td></tr>
  `;

  const footer = `
    <strong style="color:${TEXT};">Reply to this email</strong> if you have any urgent questions about your trip.<br/>
    Order ID ${escapeHtml(order.reference)} · Issued ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.
  `;

  return brandedEmail({
    subject: `Payment received — booking in progress · ${order.reference}`,
    preheader: `We received your ${currency}${total} payment for order ${order.reference}. Our team is finalising your booking.`,
    contentBlocks: content,
    footerText: footer
  });
}

async function sendBookingPending(order, failureReason) {
  const to = order.contact_email;
  if (!to) {
    console.warn('📬 No contact_email on order', order.reference, '— cannot send pending notice');
    return false;
  }
  console.log(`📬 Sending payment-received notice → ${to} (order ${order.reference})`);

  const html = bookingPendingEmail(order, failureReason);
  const subject = `Payment received — booking in progress · ${order.reference}`;

  if (!transporter) {
    console.log('───── EMAIL (SMTP not configured) — pending notice for', order.reference);
    return false;
  }

  try {
    const currency = order.total_currency === 'EUR' ? 'EUR ' :
      order.total_currency === 'USD' ? 'USD ' :
      order.total_currency === 'GBP' ? 'GBP ' : (order.total_currency || '') + ' ';
    const totalAmt = Math.round(parseFloat(order.total_amount || 0));
    const firstName = order.passengers?.[0]?.given_name || '';

    const plainText = [
      'PAYMENT RECEIVED · BOOKING IN PROGRESS',
      '======================================',
      '',
      'We have your payment.',
      '',
      `Thank you${firstName ? ', ' + firstName : ''}. We received your payment of ${currency}${totalAmt} successfully, but couldn't finalise the airline booking on the first attempt.`,
      '',
      'WHAT HAPPENS NEXT',
      '-----------------',
      'Our team has been notified and will manually issue your ticket within one business hour. You will get a separate confirmation email with your PNR as soon as it is done.',
      '',
      'You have NOT been charged twice. No action is needed from you. If you do not hear from us within an hour, please reply to this email or contact support with your order ID below.',
      '',
      'ORDER REFERENCE',
      '---------------',
      order.reference,
      '',
      'Need urgent help? Reply to this email.',
      '',
      'Lazarus Consulting LLC · Delaware, USA · flightdojo.it.com',
      'This is a transactional email regarding your FlightDojo order.'
    ].join('\n');

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      html,
      text: plainText,
      replyTo: process.env.SMTP_REPLY_TO || 'support@flightdojo.it.com',
      headers: {
        'X-FlightDojo-Order': order.reference,
        'X-Mailer': 'FlightDojo',
        'List-Unsubscribe': `<mailto:unsubscribe@flightdojo.it.com?subject=Unsubscribe-${order.reference}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'X-Auto-Response-Suppress': 'OOF, AutoReply',
        'Precedence': 'transactional'
      }
    });
    console.log('📬 ✓ Pending notice sent:', info.messageId);
    return true;
  } catch (err) {
    console.error('📬 ✗ Pending notice send failed:', err.message);
    return false;
  }
}

module.exports = {
  sendBookingConfirmation,
  sendBookingPending,
  sendWelcome,
  sendMagicLink,
  sendPasswordReset,
  sendPriceDropAlert,
  sendGroupInvite,
  sendTicketIssued,
  sendRefundIssued,
  sendCustomAdmin,
  resendByLogId,
  sendAndLog
};

// ───────────────────────────────────────────────────────────
// TICKET ISSUED (ops marks order ticketed)
// ───────────────────────────────────────────────────────────
async function sendTicketIssued(order, pnr) {
  const viewUrl = publicBookingUrl(order);

  const html = buildAccountEmail({
    headline: 'Ticket Issued',
    subheadline: 'Your airline booking reference is ready',
    intro: `Good news${order.passengers?.[0]?.given_name ? ', ' + escapeHtml(order.passengers[0].given_name) : ''}. Your ticket has been issued by the airline. Use the reference below at check-in, and for any communication with the airline directly.`,
    ctaUrl: viewUrl,
    ctaLabel: 'View my booking',
    securityNote: `<strong>Airline reference (PNR):</strong> <code style="font-size:14px;background:#fff;padding:3px 6px;border-radius:3px;letter-spacing:0.08em;font-weight:700;">${escapeHtml(pnr)}</code><br/>Your FlightDojo order ID is <strong>${escapeHtml(order.reference)}</strong>.`
  });
  return sendAndLog({
    to: order.contact_email,
    subject: `Your ticket is ready · ${pnr}`,
    html,
    text: `Your ticket has been issued.\n\nAirline reference (PNR): ${pnr}\nFlightDojo order: ${order.reference}\n\nUse the PNR at check-in.\n\nView online: ${viewUrl}\n\n— FlightDojo`,
    template: 'ticket_issued',
    user_id: order.user_id || null,
    order_reference: order.reference
  });
}

// ───────────────────────────────────────────────────────────
// REFUND ISSUED
// ───────────────────────────────────────────────────────────
async function sendRefundIssued(order, refund) {
  const currency = order.total_currency || refund.currency || 'EUR';
  const viewUrl = publicBookingUrl(order);
  const html = buildAccountEmail({
    headline: 'Refund Issued',
    subheadline: `${currency} ${refund.amount} has been refunded`,
    intro: `We've issued a refund of <strong>${currency} ${refund.amount}</strong> for your order <strong>${escapeHtml(order.reference)}</strong>. Refunds typically appear in your account within 5-10 business days, depending on your bank.`,
    ctaUrl: viewUrl,
    ctaLabel: 'View order',
    securityNote: refund.reason ? `<strong>Reason:</strong> ${escapeHtml(refund.reason)}${refund.notes ? '<br/><br/>' + escapeHtml(refund.notes) : ''}` : null
  });
  return sendAndLog({
    to: order.contact_email,
    subject: `Refund issued · ${currency} ${refund.amount} · ${order.reference}`,
    html,
    text: `A refund of ${currency} ${refund.amount} has been issued for order ${order.reference}.\n\nIt should appear in your account within 5-10 business days.\n\n${refund.reason ? 'Reason: ' + refund.reason + '\n\n' : ''}— FlightDojo`,
    template: 'refund_issued',
    user_id: order.user_id || null,
    order_reference: order.reference
  });
}

// ───────────────────────────────────────────────────────────
// CUSTOM EMAIL FROM ADMIN (free-form, with brand wrapper)
// ───────────────────────────────────────────────────────────
async function sendCustomAdmin({ to, subject, message, order_reference, user_id }) {
  // Convert plain text message to HTML paragraphs (preserving line breaks)
  const messageHtml = String(message || '')
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 14px 0;font-size:14px;color:#1a1a1a;line-height:1.65;">${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');

  const html = buildAccountEmail({
    headline: order_reference ? `Order ${order_reference}` : 'A note from FlightDojo',
    subheadline: subject,
    intro: messageHtml,
    ctaUrl: null,
    ctaLabel: null
  });

  return sendAndLog({
    to,
    subject,
    html,
    text: message,
    template: 'admin_custom',
    user_id: user_id || null,
    order_reference: order_reference || null
  });
}

// ───────────────────────────────────────────────────────────
// RESEND A LOGGED EMAIL
// ───────────────────────────────────────────────────────────
async function resendByLogId(logId, actorUser) {
  const EmailLog = getEmailLog();
  if (!EmailLog) return { ok: false, error: 'EmailLog model unavailable' };
  const original = await EmailLog.findById(logId);
  if (!original) return { ok: false, error: 'Original email not found' };

  // We don't store the full HTML body in the log. For most templates we can
  // reconstruct by looking up the order/user. For 'admin_custom' we can re-send
  // just the preview text.
  let html, text;
  if (original.template === 'admin_custom' && original.preview) {
    text = original.preview;
    html = buildAccountEmail({
      headline: original.order_reference ? `Order ${original.order_reference}` : 'A note from FlightDojo',
      subheadline: original.subject,
      intro: `<p>${escapeHtml(original.preview)}</p>`,
      ctaUrl: null
    });
  } else if (original.template === 'booking_confirmation' && original.order_reference) {
    const Order = require('../models/Order');
    const order = await Order.findOne({ reference: original.order_reference }).lean();
    if (!order) return { ok: false, error: 'Order no longer exists' };
    return sendBookingConfirmation(order);
  } else {
    return { ok: false, error: `Cannot reconstruct template "${original.template}" — please ask the system to re-trigger it instead.` };
  }

  const result = await sendAndLog({
    to: original.to,
    subject: '[Resent] ' + original.subject,
    html, text,
    template: original.template,
    user_id: original.user_id,
    order_reference: original.order_reference
  });

  // Mark resend on the original log entry
  original.resend_count = (original.resend_count || 0) + 1;
  await original.save();

  if (result.logId) {
    await EmailLog.updateOne({ _id: result.logId }, { resent_from_log_id: original._id });
  }
  return result;
}

// ───────────────────────────────────────────────────────────
// PRICE DROP ALERT
// ───────────────────────────────────────────────────────────
async function sendPriceDropAlert(user, payload) {
  if (!transporter) {
    console.log(`───── PRICE DROP (SMTP not configured) → ${user.email}: ${payload.route} ${payload.drop_percent}% off`);
    return false;
  }
  const html = buildAccountEmail({
    headline: `Price drop · ${payload.drop_percent}% off`,
    subheadline: `Your saved trip just dropped to ${payload.currency} ${payload.new_price}`,
    intro: `Great news${user.name ? ', ' + escapeHtml(user.name) : ''}. The fare for <strong>${escapeHtml(payload.route)}</strong> on <strong>${escapeHtml(payload.depart_date)}</strong>${payload.return_date ? ` (returning ${escapeHtml(payload.return_date)})` : ''} dropped from <strong>${payload.currency} ${payload.old_price}</strong> to <strong>${payload.currency} ${payload.new_price}</strong>. That's <strong>${payload.drop_percent}% less</strong> than your saved price.`,
    ctaUrl: payload.book_url,
    ctaLabel: 'Book this fare',
    securityNote: 'Fares change quickly. This price was valid moments ago but may shift again — book soon to lock it in.'
  });
  try {
    const info = await transporter.sendMail({
      from,
      to: user.email,
      subject: `Price drop · ${payload.route} · ${payload.drop_percent}% off`,
      html,
      text: `Price drop for ${payload.route} on ${payload.depart_date}:\n\nNew price: ${payload.currency} ${payload.new_price} (was ${payload.currency} ${payload.old_price}, ${payload.drop_percent}% off)\n\nBook: ${payload.book_url}\n\n— FlightDojo`,
      replyTo: process.env.SMTP_REPLY_TO || 'support@flightdojo.it.com',
      headers: { 'X-Mailer': 'FlightDojo', 'Precedence': 'transactional' }
    });
    console.log('📬 ✓ Price drop sent:', info.messageId);
    return true;
  } catch (err) {
    console.error('📬 ✗ Price drop send failed:', err.message);
    return false;
  }
}

// ───────────────────────────────────────────────────────────
// GROUP INVITE
// ───────────────────────────────────────────────────────────
async function sendGroupInvite(email, fromUser, group, inviteUrl) {
  if (!transporter) {
    console.log(`───── GROUP INVITE (SMTP not configured) → ${email} for "${group.name}"`);
    return false;
  }
  const senderName = fromUser.name || fromUser.email;
  const html = buildAccountEmail({
    headline: 'Group invite',
    subheadline: `${escapeHtml(senderName)} invited you to a FlightDojo group`,
    intro: `<strong>${escapeHtml(senderName)}</strong> invited you to join the group "<strong>${escapeHtml(group.name)}</strong>" on FlightDojo. Group members can share and view each other's trip bookings — useful for families, work travel, or trips you book on behalf of others.`,
    ctaUrl: inviteUrl,
    ctaLabel: 'Accept invite',
    securityNote: 'This invitation expires in 14 days. If you don\'t have a FlightDojo account yet, you\'ll be asked to create one before joining.'
  });
  try {
    const info = await transporter.sendMail({
      from,
      to: email,
      subject: `${senderName} invited you to "${group.name}" on FlightDojo`,
      html,
      text: `${senderName} invited you to join "${group.name}" on FlightDojo.\n\nAccept: ${inviteUrl}\n\nThis invite expires in 14 days.\n\n— FlightDojo`,
      replyTo: process.env.SMTP_REPLY_TO || 'support@flightdojo.it.com',
      headers: { 'X-Mailer': 'FlightDojo', 'Precedence': 'transactional' }
    });
    console.log('📬 ✓ Group invite sent:', info.messageId);
    return true;
  } catch (err) {
    console.error('📬 ✗ Group invite send failed:', err.message);
    return false;
  }
}

// ───────────────────────────────────────────────────────────
// ACCOUNT-RELATED EMAILS
// ───────────────────────────────────────────────────────────

function buildAccountEmail({ headline, subheadline, intro, ctaUrl, ctaLabel, securityNote }) {
  const CORAL = '#FF5038';
  const TEXT = '#1a1a1a';
  const MUTED = '#6b6b6b';
  const SOFT = '#fdf3f1';

  const content = `
    <tr><td style="padding:32px;">
      ${headline ? `<div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${CORAL};font-weight:700;margin-bottom:8px;">${escapeHtml(headline)}</div>` : ''}
      <h1 style="margin:0 0 18px 0;font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:800;color:${TEXT};line-height:1.1;">
        ${escapeHtml(subheadline)}
      </h1>
      <p style="margin:0 0 24px 0;font-size:14px;color:${MUTED};line-height:1.65;">
        ${intro}
      </p>
      ${ctaUrl ? `
        <div style="text-align:center;margin:24px 0;">
          <a href="${escapeHtml(ctaUrl)}"
             style="display:inline-block;background:${CORAL};color:#fff;text-decoration:none;font-family:Georgia,serif;font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;padding:14px 32px;border-radius:4px;">
            ${escapeHtml(ctaLabel || 'Continue')} →
          </a>
        </div>
        <div style="font-size:11px;color:${MUTED};margin-top:8px;word-break:break-all;">
          Or copy and paste this link into your browser:<br/>
          <a href="${escapeHtml(ctaUrl)}" style="color:${CORAL};">${escapeHtml(ctaUrl)}</a>
        </div>
      ` : ''}
      ${securityNote ? `
        <div style="margin-top:24px;padding:14px 16px;background:${SOFT};border-left:3px solid ${CORAL};font-size:12px;color:${TEXT};line-height:1.6;">
          ${securityNote}
        </div>
      ` : ''}
    </td></tr>
  `;

  return brandedEmail({
    subject: subheadline,
    preheader: intro.replace(/<[^>]+>/g, '').slice(0, 100),
    contentBlocks: content,
    footerText: `If you didn't request this, you can safely ignore this email.<br/>Sent ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.`
  });
}

async function sendWelcome(user, dashboardUrl, linkedOrdersCount) {
  if (!transporter) {
    console.log('───── WELCOME EMAIL (SMTP not configured) → ' + user.email);
    return false;
  }
  const html = buildAccountEmail({
    headline: 'Account Created',
    subheadline: 'Welcome to FlightDojo.',
    intro: `Hi${user.name ? ' ' + escapeHtml(user.name) : ''}, your FlightDojo account is ready. ${linkedOrdersCount > 0 ? `We've linked <strong>${linkedOrdersCount} existing booking${linkedOrdersCount > 1 ? 's' : ''}</strong> to your account so you can view them all in one place.` : 'All your future bookings will be saved here automatically.'}`,
    ctaUrl: dashboardUrl,
    ctaLabel: 'Open my dashboard'
  });
  try {
    console.log(`📬 → Welcome email → ${user.email}`);
    const info = await transporter.sendMail({
      from,
      to: user.email,
      subject: 'Welcome to FlightDojo',
      html,
      text: `Welcome to FlightDojo${user.name ? ', ' + user.name : ''}.\n\nYour account is ready. Open your dashboard: ${dashboardUrl}\n\n— FlightDojo`,
      replyTo: process.env.SMTP_REPLY_TO || 'support@flightdojo.it.com',
      headers: {
        'X-Mailer': 'FlightDojo',
        'List-Unsubscribe': '<mailto:unsubscribe@flightdojo.it.com>',
        'Precedence': 'transactional'
      }
    });
    console.log('📬 ✓ Welcome sent:', info.messageId);
    return true;
  } catch (err) {
    console.error('📬 ✗ Welcome send failed:', err.message);
    return false;
  }
}

async function sendMagicLink(user, linkUrl) {
  if (!transporter) {
    console.log('───── MAGIC LINK (SMTP not configured) → ' + user.email);
    console.log('Link:', linkUrl);
    return false;
  }
  const html = buildAccountEmail({
    headline: 'Sign-in link',
    subheadline: 'Tap to sign in to FlightDojo',
    intro: `Click the button below to sign in to your FlightDojo account. This link expires in <strong>15 minutes</strong> and can only be used once.`,
    ctaUrl: linkUrl,
    ctaLabel: 'Sign in',
    securityNote: '<strong>Didn\'t request this?</strong> Someone may have entered your email address by mistake. You can safely ignore this email — no changes will be made to your account.'
  });
  try {
    const info = await transporter.sendMail({
      from,
      to: user.email,
      subject: 'Your FlightDojo sign-in link',
      html,
      text: `Tap to sign in to your FlightDojo account:\n\n${linkUrl}\n\nThis link expires in 15 minutes and can only be used once.\n\nIf you didn't request this, ignore this email.\n\n— FlightDojo`,
      replyTo: process.env.SMTP_REPLY_TO || 'support@flightdojo.it.com',
      headers: { 'X-Mailer': 'FlightDojo', 'Precedence': 'transactional' }
    });
    console.log('📬 ✓ Magic link sent:', info.messageId);
    return true;
  } catch (err) {
    console.error('📬 ✗ Magic link send failed:', err.message);
    return false;
  }
}

async function sendPasswordReset(user, linkUrl) {
  if (!transporter) {
    console.log('───── PASSWORD RESET (SMTP not configured) → ' + user.email);
    console.log('Link:', linkUrl);
    return false;
  }
  const html = buildAccountEmail({
    headline: 'Reset Password',
    subheadline: 'Reset your FlightDojo password',
    intro: `We received a request to reset the password for your FlightDojo account. Click the button below to set a new password. This link expires in <strong>1 hour</strong>.`,
    ctaUrl: linkUrl,
    ctaLabel: 'Reset password',
    securityNote: '<strong>Didn\'t request this?</strong> Your password is unchanged. You can safely ignore this email — but if you keep seeing these, please contact support.'
  });
  try {
    const info = await transporter.sendMail({
      from,
      to: user.email,
      subject: 'Reset your FlightDojo password',
      html,
      text: `Reset your FlightDojo password:\n\n${linkUrl}\n\nExpires in 1 hour.\n\nIf you didn't request this, ignore this email.\n\n— FlightDojo`,
      replyTo: process.env.SMTP_REPLY_TO || 'support@flightdojo.it.com',
      headers: { 'X-Mailer': 'FlightDojo', 'Precedence': 'transactional' }
    });
    console.log('📬 ✓ Password reset sent:', info.messageId);
    return true;
  } catch (err) {
    console.error('📬 ✗ Password reset send failed:', err.message);
    return false;
  }
}

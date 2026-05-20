const nodemailer = require('nodemailer');

const host = process.env.SMTP_HOST;
const port = parseInt(process.env.SMTP_PORT || '587', 10);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = process.env.SMTP_FROM || 'FlightDojo <noreply@flightdojo.it.com>';

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
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader || '')}</div>
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
        <a href="${escapeHtml(process.env.BASE_URL || 'https://flightdojo.it.com')}/booking/${escapeHtml(order.reference)}"
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

  const subject = `Booking Confirmed · ${order.booking_reference || order.reference}`;
  console.log(`📬 Sending confirmation email → ${to} (order ${order.reference})`);

  if (!transporter) {
    console.log('───── EMAIL (SMTP not configured, would have sent) ─────');
    console.log('To:', to);
    console.log('Subject:', subject);
    console.log('HTML length:', html.length, 'bytes');
    console.log('────────────────────────────────────────────────────────');
    return false;
  }

  try {
    console.log(`📬 → Sending confirmation to ${to} via ${host}…`);
    const info = await transporter.sendMail({
      from, to, subject, html,
      text: `Your FlightDojo booking is confirmed.\n\nReference: ${order.booking_reference || order.reference}\nTotal: ${order.total_currency} ${order.total_amount}\n\nView online: ${process.env.BASE_URL || 'https://flightdojo.it.com'}/booking/${order.reference}\n\n— FlightDojo`,
      // Plain-text fallback header so providers can tell this is transactional
      headers: { 'X-FlightDojo-Order': order.reference }
    });
    console.log('📬 ✓ Confirmation accepted by SMTP server:');
    console.log('   messageId:', info.messageId);
    console.log('   response: ', info.response);
    console.log('   accepted: ', info.accepted);
    console.log('   rejected: ', info.rejected);
    if (info.rejected && info.rejected.length > 0) {
      console.error('📬 ⚠  Some recipients were REJECTED:', info.rejected);
      return false;
    }
    return true;
  } catch (err) {
    console.error('📬 ✗ Confirmation send FAILED:', err.message);
    if (err.response) console.error('   SMTP response:', err.response);
    if (err.responseCode) console.error('   SMTP code:', err.responseCode);
    if (err.code) console.error('   Error code:', err.code);
    return false;
  }
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
    const info = await transporter.sendMail({
      from, to, subject, html,
      text: `Hi${order.passengers?.[0]?.given_name ? ' ' + order.passengers[0].given_name : ''},\n\nWe received your payment for order ${order.reference} but couldn't finalise the airline booking automatically. Our team will issue your ticket manually within one business hour.\n\nYou have not been charged twice. If you don't hear from us, reply to this email.\n\n— FlightDojo`
    });
    console.log('📬 ✓ Pending notice sent:', info.messageId);
    return true;
  } catch (err) {
    console.error('📬 ✗ Pending notice send failed:', err.message);
    return false;
  }
}

module.exports = { sendBookingConfirmation, sendBookingPending };

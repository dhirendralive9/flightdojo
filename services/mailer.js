const nodemailer = require('nodemailer');

const host = process.env.SMTP_HOST;
const port = parseInt(process.env.SMTP_PORT || '587', 10);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = process.env.SMTP_FROM || 'FlightDojo <noreply@flightdojo.it.com>';

const configured = host && user && pass && !user.includes('REPLACE_ME');

let transporter = null;

if (configured) {
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
  transporter.verify((err) => {
    if (err) console.warn('⚠  SMTP verify failed:', err.message);
    else console.log(`📬 SMTP transport ready (${host}:${port})`);
  });
} else {
  console.warn('⚠  SMTP not configured — emails will be logged to console only');
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
        Your trip is booked.
      </h1>
      <p style="margin:0 0 24px 0;font-size:14px;color:${MUTED};line-height:1.65;">
        Thank you${order.passengers?.[0]?.given_name ? ', ' + escapeHtml(order.passengers[0].given_name) : ''}.
        Your flight booking is confirmed. Save this email or keep it accessible — you'll need the booking reference below at check-in.
      </p>

      <div style="background:${SOFT};border-left:3px solid ${CORAL};padding:14px 18px;margin-bottom:24px;">
        <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${MUTED};font-weight:600;margin-bottom:4px;">
          Booking Reference
        </div>
        <div style="font-family:Georgia,serif;font-size:22px;font-weight:800;color:${TEXT};letter-spacing:0.08em;">
          ${escapeHtml(order.booking_reference || order.reference)}
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
    console.warn('No contact_email on order', order.reference);
    return false;
  }

  const subject = `Booking Confirmed · ${order.booking_reference || order.reference}`;

  if (!transporter) {
    console.log('───── EMAIL (SMTP not configured, would have sent) ─────');
    console.log('To:', to);
    console.log('Subject:', subject);
    console.log('HTML length:', html.length, 'bytes');
    console.log('────────────────────────────────────────────────────────');
    return false;
  }

  try {
    const info = await transporter.sendMail({
      from, to, subject, html,
      text: `Your FlightDojo booking is confirmed.\n\nReference: ${order.booking_reference || order.reference}\nTotal: ${order.total_currency} ${order.total_amount}\n\nView online: ${process.env.BASE_URL || 'https://flightdojo.it.com'}/booking/${order.reference}\n\n— FlightDojo`
    });
    console.log('📬 Email sent:', info.messageId, '→', to);
    return true;
  } catch (err) {
    console.error('Email send failed:', err.message);
    return false;
  }
}

module.exports = { sendBookingConfirmation };

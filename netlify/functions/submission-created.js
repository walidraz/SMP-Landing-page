// Fires on every Netlify Form submission.
// Primary responsibility: send WhatsApp notification to SMP team via Twilio.
// Secondary (fire-and-forget): invoke lead-capi function for Meta Conversions API.
// IMPORTANT: Twilio logic below is kept identical to the last known-good version.
// CAPI is intentionally decoupled — any CAPI failure cannot affect Twilio delivery.

const NOTIFY_WHATSAPP = 'whatsapp:+447727629926'; // destination (joined sandbox with "join fallen-deal")

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const payload = body.payload || {};
    const data = payload.data || {};

    const name = (data.name || 'Unknown').toString().trim();
    const email = (data.email || '—').toString().trim();
    const phone = (data.phone || '—').toString().trim();
    const age = (data.age || '—').toString().trim();
    const service = (data.service || 'home').toString().trim();
    const qualifier = (data.qualifier || '').toString().trim();

    // ─── Fire-and-forget: CAPI on a separate path, never blocks or affects Twilio ───
    fireCAPIDecoupled(event.headers, data).catch(err => {
      console.error('CAPI side-call failed (ignored, WhatsApp unaffected):', err);
    });

    const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    const fromNumber = (process.env.TWILIO_WHATSAPP_FROM || '').trim();

    console.log('DEBUG env:', {
      sidPrefix: accountSid.slice(0, 4),
      sidLen: accountSid.length,
      tokenLen: authToken.length,
      fromRaw: JSON.stringify(fromNumber),
      fromLen: fromNumber.length,
      toRaw: JSON.stringify(NOTIFY_WHATSAPP)
    });

    if (!accountSid || !authToken || !fromNumber) {
      console.error('Missing Twilio env vars — skipping WhatsApp notification');
      return { statusCode: 200, body: 'skipped (missing config)' };
    }

    const qualifierLine = qualifier ? `\nDetails: ${qualifier}` : '';
    const message =
`🔔 New SMP Lead

Name: ${name}
Phone: ${phone}
Email: ${email}
Age: ${age}
Service: ${service}${qualifierLine}

📝 Contact ASAP`;

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const params = new URLSearchParams({
      From: fromNumber,
      To: NOTIFY_WHATSAPP,
      Body: message
    });

    const response = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Twilio error:', response.status, result);
      // Return 200 so Netlify doesn't mark the submission as failed
      return { statusCode: 200, body: 'twilio error logged' };
    }

    console.log('WhatsApp sent, SID:', result.sid);
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('submission-created function error:', err);
    return { statusCode: 200, body: 'error logged' };
  }
};

// ─── Decoupled CAPI invocation: calls the separate function over HTTP ───
// This is fire-and-forget. If it fails, the main Twilio flow is unaffected.
async function fireCAPIDecoupled(headers, data) {
  try {
    const host = (headers && (headers['x-forwarded-host'] || headers.host)) || 'enquiry.secure-mp.com';
    const proto = (headers && headers['x-forwarded-proto']) || 'https';
    const url = `${proto}://${host}/.netlify/functions/lead-capi`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data })
    });
  } catch (err) {
    // swallow — CAPI must never break Twilio
    console.error('CAPI invoke failed:', err);
  }
}

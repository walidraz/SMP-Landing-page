// Fires on every Netlify Form submission.
// - Sends a WhatsApp notification via Twilio
// - Sends a Lead event to Meta Conversions API (server-side)

const NOTIFY_WHATSAPP = 'whatsapp:+447727629926'; // destination (joined sandbox with "join fallen-deal")

// SHA-256 hash helper — Meta requires all PII to be hashed
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Normalize UK phone to E.164 (+44...) before hashing
function normalizePhone(raw) {
  let p = (raw || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '44' + p.slice(1);
  else if (p.startsWith('44')) { /* already good */ }
  else if (p.length === 10 || p.length === 11) p = '44' + p;
  return p;
}

async function sendToMetaCAPI({ name, email, phone, age, service, qualifier, userAgent, clientIp, fbp, fbc, eventId }) {
  const pixelId = (process.env.META_PIXEL_ID || '').trim();
  const token = (process.env.META_CAPI_TOKEN || '').trim();
  if (!pixelId || !token) {
    console.log('Meta CAPI: missing env vars, skipping');
    return { skipped: true };
  }

  const [firstName, ...rest] = name.split(/\s+/);
  const lastName = rest.join(' ');

  const hashedEmail = email && email !== '-' ? await sha256(email) : null;
  const hashedPhone = phone && phone !== '-' ? await sha256(normalizePhone(phone)) : null;
  const hashedFirstName = firstName ? await sha256(firstName) : null;
  const hashedLastName = lastName ? await sha256(lastName) : null;
  const hashedCountry = await sha256('gb');
  const hashedAge = age && age !== '-' ? await sha256(String(age)) : null;

  const userData = {};
  if (hashedEmail) userData.em = [hashedEmail];
  if (hashedPhone) userData.ph = [hashedPhone];
  if (hashedFirstName) userData.fn = [hashedFirstName];
  if (hashedLastName) userData.ln = [hashedLastName];
  if (hashedAge) userData.ge = [hashedAge]; // age, not gender — but Meta uses 'ge' for gender; skip if wrong
  userData.country = [hashedCountry];
  if (userAgent) userData.client_user_agent = userAgent;
  if (clientIp) userData.client_ip_address = clientIp;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  // Remove age — Meta doesn't have a standard field for it; keep it in custom_data instead
  delete userData.ge;

  // Use event_id from the browser if provided, else generate one (no dedup possible in that case)
  const finalEventId = eventId || `lead_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_id: finalEventId,
      action_source: 'website',
      event_source_url: `https://enquiry.secure-mp.com/${service !== 'home' ? service : ''}`,
      user_data: userData,
      custom_data: {
        content_name: service,
        content_category: 'callback-request',
        lead_age: age,
        lead_qualifier: qualifier || ''
      }
    }]
  };

  // If META_TEST_EVENT_CODE env var is set, route events to Meta's Test Events tab for verification
  const testCode = (process.env.META_TEST_EVENT_CODE || '').trim();
  if (testCode) payload.test_event_code = testCode;

  const url = `https://graph.facebook.com/v18.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (!res.ok) {
      console.error('Meta CAPI error:', res.status, result);
      return { ok: false, result };
    }
    console.log('Meta CAPI sent:', result);
    return { ok: true, result, eventId: finalEventId };
  } catch (err) {
    console.error('Meta CAPI fetch failed:', err);
    return { ok: false, error: String(err) };
  }
}

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const payload = body.payload || {};
    const data = payload.data || {};

    const name = (data.name || 'Unknown').toString().trim();
    const email = (data.email || '-').toString().trim();
    const phone = (data.phone || '-').toString().trim();
    const age = (data.age || '-').toString().trim();
    const service = (data.service || 'home').toString().trim();
    const qualifier = (data.qualifier || '').toString().trim();

    // Meta CAPI metadata (captured by the browser and sent via hidden form fields)
    const userAgent = (data.user_agent || '').toString();
    const clientIp = ''; // not available from Netlify Forms payload; Meta uses fbp/email/phone for matching
    const fbp = (data._fbp || '').toString();
    const fbc = (data._fbc || '').toString();
    const eventId = (data.event_id || '').toString();

    // ─── Fire both notifications in parallel ───
    const [twilioResult, capiResult] = await Promise.allSettled([
      sendWhatsApp({ name, email, phone, age, service, qualifier }),
      sendToMetaCAPI({ name, email, phone, age, service, qualifier, userAgent, clientIp, fbp, fbc, eventId })
    ]);

    console.log('Results:', {
      twilio: twilioResult.status,
      capi: capiResult.status
    });

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('submission-created function error:', err);
    return { statusCode: 200, body: 'error logged' };
  }
};

async function sendWhatsApp({ name, email, phone, age, service, qualifier }) {
  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  const fromNumber = (process.env.TWILIO_WHATSAPP_FROM || '').trim();

  if (!accountSid || !authToken || !fromNumber) {
    console.error('Missing Twilio env vars, skipping WhatsApp');
    return { skipped: true };
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

  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    console.error('Twilio error:', response.status, result);
    return { ok: false, result };
  }
  const result = await response.json();
  console.log('WhatsApp sent, SID:', result.sid);
  return { ok: true, sid: result.sid };
}

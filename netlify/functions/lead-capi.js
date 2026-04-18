// Isolated Meta Conversions API sender.
// Called (fire-and-forget) by submission-created after form submissions.
// This file does NOT touch Twilio. Any failure here is contained.

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str).toLowerCase().trim()));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizePhoneUK(raw) {
  let p = (raw || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '44' + p.slice(1);
  else if (p.startsWith('44')) { /* ok */ }
  else if (p.length === 10 || p.length === 11) p = '44' + p;
  return p;
}

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const data = body.data || {};

    const pixelId = (process.env.META_PIXEL_ID || '').trim();
    const token = (process.env.META_CAPI_TOKEN || '').trim();
    if (!pixelId || !token) {
      console.log('CAPI: missing env vars, skipping');
      return { statusCode: 200, body: 'skipped' };
    }

    // ─── Safety guard: skip CAPI for obvious test traffic ───
    // Prevents curl / bot tests from contaminating production Meta data.
    const incomingUA = (data.user_agent || event.headers['user-agent'] || '').toLowerCase();
    const skipUserAgents = ['curl', 'wget', 'postman', 'insomnia', 'testbot', 'python-requests', 'node-fetch'];
    const testEmail = (data.email || '').toLowerCase();
    const isTestEmail = /^(test|debug|fresh|trace|isolated|qa|demo)/i.test(testEmail) || testEmail.includes('@example.com') || testEmail.includes('@ex.com') || testEmail === 'd@e.com';
    if (skipUserAgents.some(ua => incomingUA.includes(ua)) || isTestEmail) {
      console.log('CAPI: skipped test traffic', { ua: incomingUA.slice(0, 40), email: testEmail });
      return { statusCode: 200, body: 'skipped (test traffic)' };
    }

    const name = (data.name || '').toString().trim();
    const email = (data.email || '').toString().trim();
    const phone = (data.phone || '').toString().trim();
    const age = (data.age || '').toString().trim();
    const service = (data.service || 'home').toString().trim();
    const qualifier = (data.qualifier || '').toString().trim();
    const userAgent = (data.user_agent || '').toString();
    const fbp = (data._fbp || '').toString();
    const fbc = (data._fbc || '').toString();
    const eventId = (data.event_id || `lead_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`).toString();

    const [firstName, ...rest] = name.split(/\s+/);
    const lastName = rest.join(' ');

    const userData = {};
    if (email && email !== '—') userData.em = [await sha256(email)];
    if (phone && phone !== '—') userData.ph = [await sha256(normalizePhoneUK(phone))];
    if (firstName) userData.fn = [await sha256(firstName)];
    if (lastName) userData.ln = [await sha256(lastName)];
    userData.country = [await sha256('gb')];
    if (userAgent) userData.client_user_agent = userAgent;
    if (fbp) userData.fbp = fbp;
    if (fbc) userData.fbc = fbc;

    const payload = {
      data: [{
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'website',
        event_source_url: `https://enquiry.secure-mp.com/${service !== 'home' ? service : ''}`,
        user_data: userData,
        custom_data: {
          content_name: service,
          content_category: 'callback-request',
          lead_age: age,
          lead_qualifier: qualifier
        }
      }]
    };

    const testCode = (process.env.META_TEST_EVENT_CODE || '').trim();
    if (testCode) payload.test_event_code = testCode;

    const url = `https://graph.facebook.com/v18.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();

    if (!res.ok) {
      console.error('CAPI: Meta returned error', res.status, result);
      return { statusCode: 200, body: 'capi error logged' };
    }
    console.log('CAPI: sent', { eventId, result });
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('CAPI: unexpected error', err);
    return { statusCode: 200, body: 'error logged' };
  }
};

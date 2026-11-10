import crypto from 'node:crypto';

/**
 * Phone notifications through Firebase Cloud Messaging (HTTP v1).
 *
 * The Android app registers a device token with the server after sign-in
 * (routes/notifications: /push/device). Sending needs a Firebase service
 * account, given to the server as FCM_SERVICE_ACCOUNT - the JSON key file's
 * contents, or the same base64-encoded - kept in Secrets Manager like every
 * other secret. Without it the phone channel is simply off and nothing else
 * changes.
 *
 * No SDK: a signed JWT is exchanged for an hour-long access token, cached, and
 * each message is one HTTPS call.
 */

let sender = null; // tests swap in a fake
export function setFcmSender(fn) { sender = fn; tokenCache = null; }

let parsed;
let parsedFrom;
export function fcmCredentials() {
  const raw = (process.env.FCM_SERVICE_ACCOUNT || '').trim();
  if (raw === parsedFrom) return parsed;
  parsedFrom = raw;
  parsed = null;
  if (!raw) return null;
  try {
    const json = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    if (json.project_id && json.client_email && json.private_key) parsed = json;
  } catch { /* a malformed key leaves the channel off */ }
  return parsed;
}

export const fcmConfigured = () => !!sender || !!fcmCredentials();

let tokenCache = null;
async function accessToken(creds) {
  if (tokenCache && tokenCache.expires > Date.now() + 60_000) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(creds.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Firebase sign-in failed: ${body.error_description || body.error || res.status}`);
  tokenCache = { token: body.access_token, expires: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}

/** A token Firebase no longer knows (app uninstalled, data cleared): the caller drops it. */
export class GoneDevice extends Error {}

/**
 * One notification to one phone. `message` is what the browser pop-up gets:
 * { title, body, link, tag }. The link travels as data so a tap opens that page.
 */
export async function sendToDevice(token, message) {
  const payload = {
    message: {
      token,
      notification: { title: String(message.title || 'TeamBridge').slice(0, 200), body: String(message.body || '').slice(0, 1000) },
      data: { link: String(message.link || '/'), tag: String(message.tag || '') },
      android: {
        priority: 'HIGH',
        notification: { channel_id: 'general', tag: message.tag ? String(message.tag).slice(0, 100) : undefined, default_sound: true },
      },
    },
  };
  if (sender) return sender(token, payload);

  const creds = fcmCredentials();
  if (!creds) throw new Error('Phone notifications are not set up on this server');
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${creds.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(creds)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) return res.json();
  const body = await res.json().catch(() => ({}));
  const code = body?.error?.details?.find?.((d) => d.errorCode)?.errorCode || body?.error?.status;
  const text = body?.error?.message || `HTTP ${res.status}`;
  if (res.status === 404 || code === 'UNREGISTERED' || /registration token/i.test(text)) throw new GoneDevice(text);
  if (res.status === 401) tokenCache = null;
  throw new Error(text);
}

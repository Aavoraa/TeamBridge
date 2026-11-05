import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { nowIso } from '../lib/util.js';

/**
 * Outbound email. With EMAIL_PROVIDER=smtp and SMTP_HOST set, mail goes out
 * through that server (any mailbox provider: the company's own host, Gmail
 * Workspace, SES SMTP...). Otherwise it is only logged, which keeps dev and
 * tests from ever sending real mail. Tests can swap the sender in.
 */
let transport = null;
let testSender = null;
export function setMailSender(fn) { testSender = fn; transport = null; }

export const emailConfigured = () => !!testSender
  || (config.providers.email === 'smtp' && !!config.providers.smtp.host);

function smtp() {
  if (!transport) {
    const s = config.providers.smtp;
    transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.port === 465, // 465 is TLS from the start; 587 upgrades with STARTTLS
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
      pool: true,
      maxConnections: 2,
      // A bulk invite should not hang the request on a dead mail server.
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  return transport;
}

/** Returns { ok, ref } or { ok: false, error }. `logged: true` means nothing was sent. */
export async function sendMail({ to, subject, text, html, replyTo }) {
  if (testSender) return testSender({ to, subject, text, html, replyTo });
  if (!emailConfigured()) {
    console.log(JSON.stringify({ t: nowIso(), mail: 'log', to, subject }));
    return { ok: true, ref: null, logged: true };
  }
  try {
    const info = await smtp().sendMail({
      from: config.providers.smtp.from, to, subject, text, html, replyTo: replyTo || undefined,
    });
    return { ok: true, ref: info.messageId || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** A personal invitation: the person creates their own account, then the owner approves it. */
export function joinInviteEmail({ name, workspace, invitedBy, url }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const by = invitedBy ? `${invitedBy} has invited you` : 'You have been invited';
  const subject = `You're invited to join ${workspace} on TeamBridge`;
  const text = [
    `Hi ${first},`, '',
    `${by} to join ${workspace} on TeamBridge.`, '',
    'Create your account here (fill in your details, role and password):', url, '',
    `${invitedBy || 'The owner'} will review it, and you can sign in once it is approved.`, '',
    'This link is only for you and works once. If you were not expecting this, you can ignore this email.',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f7f8fa;font-family:Inter,Segoe UI,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:20px;font-weight:700;color:#17703f;padding-bottom:20px">TeamBridge</td></tr>
<tr><td style="font-size:15px;line-height:1.6">
<p style="margin:0 0 12px">Hi ${esc(first)},</p>
<p style="margin:0 0 20px">${esc(by)} to join <strong>${esc(workspace)}</strong> on TeamBridge. Create your account with your details, role and password. ${esc(invitedBy || 'The owner')} will review it, and you can sign in once it is approved.</p>
<p style="margin:0 0 24px"><a href="${esc(url)}" style="display:inline-block;background:#17703f;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">Create my account</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#6b7280">This link is only for you and works once. If the button does not open, copy this link:</p>
<p style="margin:0 0 20px;font-size:12px;word-break:break-all;color:#6b7280">${esc(url)}</p>
<p style="margin:0;font-size:13px;color:#6b7280">If you were not expecting this, you can ignore this email.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

/** Sent when an owner approves a join request: the account now works. */
export function approvedEmail({ name, workspace, role, url }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const subject = `You're in: ${workspace} on TeamBridge`;
  const text = [
    `Hi ${first},`, '',
    `Your request to join ${workspace} has been approved${role ? ` (role: ${role})` : ''}.`,
    'Sign in with the email and password you chose:', url, '',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f7f8fa;font-family:Inter,Segoe UI,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:20px;font-weight:700;color:#17703f;padding-bottom:20px">TeamBridge</td></tr>
<tr><td style="font-size:15px;line-height:1.6">
<p style="margin:0 0 12px">Hi ${esc(first)},</p>
<p style="margin:0 0 20px">Your request to join <strong>${esc(workspace)}</strong> has been approved${role ? ` as <strong>${esc(role)}</strong>` : ''}. Sign in with the email and password you chose.</p>
<p style="margin:0"><a href="${esc(url)}" style="display:inline-block;background:#17703f;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">Sign in</a></p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

/** The invitation email: plain text plus a simple HTML version with one button. */
export function inviteEmail({ name, workspace, invitedBy, role, url }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const by = invitedBy ? `${invitedBy} has invited you` : 'You have been invited';
  const subject = `You're invited to join ${workspace} on TeamBridge`;
  const text = [
    `Hi ${first},`,
    '',
    `${by} to join ${workspace} on TeamBridge${role ? ` as ${role}` : ''}.`,
    '',
    'Set your password and sign in here (the link works once):',
    url,
    '',
    'If you were not expecting this, you can ignore this email.',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f7f8fa;font-family:Inter,Segoe UI,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:20px;font-weight:700;color:#17703f;padding-bottom:20px">TeamBridge</td></tr>
<tr><td style="font-size:15px;line-height:1.6">
<p style="margin:0 0 12px">Hi ${esc(first)},</p>
<p style="margin:0 0 20px">${esc(by)} to join <strong>${esc(workspace)}</strong> on TeamBridge${role ? ` as <strong>${esc(role)}</strong>` : ''}.</p>
<p style="margin:0 0 24px"><a href="${esc(url)}" style="display:inline-block;background:#17703f;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">Accept invitation</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#6b7280">The button works once. If it does not open, copy this link:</p>
<p style="margin:0 0 20px;font-size:12px;word-break:break-all;color:#6b7280">${esc(url)}</p>
<p style="margin:0;font-size:13px;color:#6b7280">If you were not expecting this, you can ignore this email.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

// Email-send abstraction.
//
// Single-provider wrapper around Resend. We deliberately don't
// support a provider matrix — Resend is the modern serverless email
// API of choice (simple SDK, good deliverability, sensible pricing)
// and every other transactional email need in this app should reuse
// this helper.
//
// Operator setup: drop a Resend API key into RESEND_API_KEY and set
// EMAIL_FROM_ADDRESS to the verified domain you're sending from
// (e.g. trust@tensorshield.ai). When either is missing the helper
// returns { ok: false, error: 'email_send_disabled' } so callers can
// fall back to "copy this link manually" UX without crashing.

import { Resend } from 'resend';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // Optional reply-to so an auditor hitting Reply goes to the
  // org admin who minted the invite, not to a generic noreply box.
  replyTo?: string;
}

export interface EmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

let cachedClient: Resend | null = null;

function getClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!cachedClient) cachedClient = new Resend(key);
  return cachedClient;
}

/** Send a transactional email. Returns ok=false (without throwing)
 *  when the email infrastructure isn't configured — callers should
 *  surface this to the UI so the operator can fall back to manually
 *  sharing the URL. */
export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  const client = getClient();
  if (!client) {
    return {
      ok: false,
      error: 'email_send_disabled',
    };
  }
  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!from) {
    return {
      ok: false,
      error: 'EMAIL_FROM_ADDRESS not configured',
    };
  }

  try {
    const res = await client.emails.send({
      from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text ?? stripHtml(msg.html),
      replyTo: msg.replyTo,
    });
    if (res.error) {
      return { ok: false, error: res.error.message ?? 'send failed' };
    }
    return { ok: true, id: res.data?.id };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Tiny HTML-to-text fallback. Resend will generate one if we don't,
 *  but ours is faster + deterministic, which matters for plain-text
 *  email-client fingerprints. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .trim();
}

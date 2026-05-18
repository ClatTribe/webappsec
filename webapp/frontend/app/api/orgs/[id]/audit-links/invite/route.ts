import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email-send';

// POST /api/orgs/[id]/audit-links/invite
//
// Auditor portal invite-by-email flow. Single round-trip:
//   1. invite_audit_share() RPC mints a token tied to the recipient
//      email (admin-gated; audit_log entry written automatically).
//   2. We compose + send the email via lib/email-send (Resend).
//   3. Response carries the new link's id + token in case the UI
//      wants to expose "copy link" as a fallback.
//
// If email-send is disabled (no RESEND_API_KEY) we still return ok=
// true with `email.ok=false` so the UI can show "we created the link
// but couldn't email it — copy this URL and send it yourself."

export const dynamic = 'force-dynamic';

const Body = z.object({
  recipient_email: z.string().email(),
  recipient_label: z.string().min(1).max(200).optional(),
  ttl_days: z.number().int().min(1).max(365).default(30),
  message: z.string().max(2000).optional(),
});

interface InviteRow {
  id: string;
  token: string;
  recipient_email: string;
  recipient_label: string | null;
  expires_at: string;
  created_at: string;
}

export async function POST(req: Request, _ctx: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.format() },
      { status: 400 },
    );
  }

  // Mint the link via the SECURITY DEFINER RPC. Admin-gating is
  // enforced inside the function.
  const { data: rows, error } = (await supabase.rpc('invite_audit_share', {
    p_recipient_email: parsed.data.recipient_email,
    p_recipient_label: parsed.data.recipient_label ?? null,
    p_ttl_days: parsed.data.ttl_days,
  } as never)) as unknown as {
    data: InviteRow[] | null;
    error: { message: string } | null;
  };
  if (error || !rows || rows.length === 0) {
    return NextResponse.json(
      { error: `invite failed: ${error?.message ?? 'unknown'}` },
      { status: 500 },
    );
  }
  const link = rows[0];

  // Resolve org name for the email body.
  const { data: orgs } = await supabase
    .from('organizations')
    .select('name, slug')
    .limit(1);
  const org = (orgs ?? [])[0] as { name?: string; slug?: string } | undefined;
  const orgName = org?.name ?? 'Your security partner';

  // Build the email body. Static HTML — Resend doesn't need a template
  // backend here; the content is mostly the link + boilerplate.
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? 'https://tensorshield.ai';
  const url = `${baseUrl}/audit/${link.token}`;
  const expiresOn = new Date(link.expires_at).toLocaleDateString();
  const replyTo = user.email ?? undefined;

  const html = renderInviteEmail({
    org_name: orgName,
    url,
    expires_on: expiresOn,
    custom_message: parsed.data.message,
  });

  const email = await sendEmail({
    to: parsed.data.recipient_email,
    subject: `${orgName} security & compliance evidence — invitation to review`,
    html,
    replyTo,
  });

  return NextResponse.json({
    ok: true,
    link: {
      id: link.id,
      token: link.token,
      recipient_email: link.recipient_email,
      recipient_label: link.recipient_label,
      expires_at: link.expires_at,
      url,
    },
    email,
  });
}

function renderInviteEmail(args: {
  org_name: string;
  url: string;
  expires_on: string;
  custom_message?: string;
}): string {
  const optMsg = args.custom_message
    ? `<p style="margin:0 0 16px;color:#404040;line-height:1.5;">${escapeHtml(args.custom_message).replace(/\n/g, '<br>')}</p>`
    : '';
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table cellpadding="0" cellspacing="0" style="max-width:560px;margin:32px auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;">
      <tr><td style="padding:32px;">
        <p style="margin:0 0 6px;font-size:11px;color:#737373;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">TensorShield · Auditor portal</p>
        <h1 style="margin:0 0 16px;font-size:24px;font-weight:600;color:#171717;">${escapeHtml(args.org_name)} invited you to review their security &amp; compliance evidence.</h1>
        ${optMsg}
        <p style="margin:0 0 16px;color:#404040;line-height:1.5;">
          The link below opens a read-only portal with their per-control compliance posture (SOC 2 / ISO 27001 / PCI DSS / HIPAA / NIST 800-53), recent findings, audit-readiness trend, and downloadable JSON export. Access is logged automatically.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${args.url}" style="display:inline-block;background:#0a0a0a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Open audit portal</a>
        </p>
        <p style="margin:0 0 8px;font-size:12px;color:#737373;">Link expires ${escapeHtml(args.expires_on)}. The org admin can revoke it at any time.</p>
        <p style="margin:0;font-size:12px;color:#737373;">Or copy and paste this URL: <span style="color:#404040;">${args.url}</span></p>
      </td></tr>
      <tr><td style="border-top:1px solid #e5e5e5;padding:16px 32px;background:#fafafa;border-radius:0 0 12px 12px;">
        <p style="margin:0;font-size:11px;color:#a3a3a3;">Sent via TensorShield — the AI security &amp; compliance engineer.</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

import Link from 'next/link';
import { buildPageMetadata } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'Privacy Policy',
  description: 'How we collect, use, and protect your data. GDPR + CCPA compliant.',
  path: '/privacy',
});

const LAST_UPDATED = '2026-04-28';

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 lg:py-24">
      <header className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">Legal</p>
        <h1 className="text-4xl font-semibold tracking-tight text-white">Privacy Policy</h1>
        <p className="text-sm text-neutral-500">Last updated: {LAST_UPDATED}</p>
      </header>

      <div className="mt-10 space-y-8 text-[15px] leading-relaxed text-neutral-300">
        <p className="rounded-lg border border-neutral-800/80 bg-neutral-900/30 p-4 text-sm text-neutral-300">
          <strong className="text-neutral-100">Plain-English summary:</strong> We collect what we
          need to run the product (your account info, the scan jobs you submit, the findings we
          produce). We don't sell your data. We don't use your scan content to train models. You
          can export everything and delete your account at any time. Detailed legal language follows.
        </p>

        <Section heading="1. Who we are">
          <p>
            "we", "us", or "our" refers to the entity operating the service at the
            domain you reached this policy from. For privacy questions, contact us at{' '}
            <a href="mailto:privacy@tensorshield.ai" className="text-cyan-300 hover:underline">
              privacy@tensorshield.ai
            </a>
            .
          </p>
        </Section>

        <Section heading="2. Data we collect">
          <p className="mb-3">We collect three categories of data:</p>
          <p>
            <strong className="text-neutral-100">2.1 Account data.</strong> Email, name, password
            hash (we never see your password), organization name, role, MFA enrollment status. You
            give us this when you sign up or update your profile.
          </p>
          <p>
            <strong className="text-neutral-100">2.2 Service data.</strong> The targets you add
            (URLs, repository links, IPs), scan configurations, scan output (findings, agent
            transcripts, logs), and triage state. This is the data the product produces and
            operates on.
          </p>
          <p>
            <strong className="text-neutral-100">2.3 Telemetry.</strong> Pages visited, feature
            usage, error reports, IP and user-agent for security purposes. We use a privacy-respecting
            analytics tool with no cross-site tracking. You can opt out via the cookie banner.
          </p>
          <p>
            We do <strong className="text-neutral-100">not</strong> collect your full source code as
            a routine matter. Source code reaches us only inside the per-scan sandbox, gets
            analyzed by the agent, and is discarded when the sandbox is destroyed at scan exit.
            Findings (which may quote snippets) are retained per your plan's retention policy.
          </p>
        </Section>

        <Section heading="3. How we use data">
          <ul className="space-y-2 pl-5 [list-style-type:disc]">
            <li>To provide the service: run scans, store findings, send notifications you've enabled.</li>
            <li>To bill you: process payments via Stripe (we never see card numbers).</li>
            <li>To support you: respond to support requests using the info you provide.</li>
            <li>To improve the product: aggregated, anonymized usage analytics.</li>
            <li>To keep the service secure: detect abuse, investigate incidents, comply with the law.</li>
          </ul>
          <p className="mt-3">
            We do <strong className="text-neutral-100">not</strong> sell your data, share it with
            advertisers, or use your scan content to train AI models — yours or anyone else's.
          </p>
        </Section>

        <Section heading="4. AI provider handling">
          <p>
            Running a scan involves sending content to an LLM provider (OpenAI, Anthropic, Gemini,
            etc.). The data sent includes the agent's reasoning, target URLs, and snippets of the
            target's code or behavior — whatever the agent needs to do its job.
          </p>
          <p className="mt-3">
            <strong className="text-neutral-100">If you bring your own LLM key</strong>, the LLM
            traffic flows directly between our worker and your chosen provider. We don't store your
            key in plaintext (it lives in Supabase Vault) and we don't log the prompts or
            responses. The relationship for that LLM data is between you and your provider.
          </p>
          <p className="mt-3">
            <strong className="text-neutral-100">If you use our default key</strong>, the same LLM
            traffic flows from our worker to the configured default provider, billed to us. We have
            data-processing agreements with our default LLM providers prohibiting them from using
            your scan content to train their models.
          </p>
        </Section>

        <Section heading="5. Subprocessors">
          <p>
            We use the following service providers ("subprocessors") to operate the service. A
            current list is also maintained on our{' '}
            <Link href="/security" className="text-cyan-300 hover:underline">
              Security page
            </Link>
            .
          </p>
          <ul className="mt-3 space-y-2 pl-5 [list-style-type:disc]">
            <li>
              <strong className="text-neutral-100">Vercel</strong> — frontend hosting and edge functions.
            </li>
            <li>
              <strong className="text-neutral-100">Supabase</strong> — database, authentication,
              vault, file storage, real-time messaging.
            </li>
            <li>
              <strong className="text-neutral-100">Fly.io</strong> — worker compute.
            </li>
            <li>
              <strong className="text-neutral-100">Stripe</strong> — payment processing.
            </li>
            <li>
              <strong className="text-neutral-100">Resend</strong> (or equivalent) — transactional email.
            </li>
            <li>
              <strong className="text-neutral-100">Your chosen LLM provider</strong> — agent inference.
            </li>
          </ul>
          <p className="mt-3">
            We notify customers of subprocessor changes at least 30 days before the change takes
            effect, via email and an update on this page.
          </p>
        </Section>

        <Section heading="6. Data retention">
          <p>
            <strong className="text-neutral-100">Account data:</strong> retained while your account
            is active and for 90 days after deletion (then permanently destroyed).
          </p>
          <p>
            <strong className="text-neutral-100">Scan findings:</strong> retained per your plan's
            retention policy. Free: 30 days. Team: 90 days. Business: configurable up to 7 years.
          </p>
          <p>
            <strong className="text-neutral-100">Audit logs:</strong> retained per your plan's
            retention policy, then archived to encrypted cold storage as required for compliance.
          </p>
          <p>
            <strong className="text-neutral-100">Backups:</strong> retained for 30 days then
            destroyed.
          </p>
        </Section>

        <Section heading="7. Your rights">
          <p>If you're in the EU, UK, California, India, or other jurisdictions with privacy laws, you have rights including:</p>
          <ul className="mt-3 space-y-2 pl-5 [list-style-type:disc]">
            <li>
              <strong className="text-neutral-100">Access.</strong> See what data we have about you.
            </li>
            <li>
              <strong className="text-neutral-100">Portability.</strong> Get a machine-readable
              export of your scans and findings via the in-app export.
            </li>
            <li>
              <strong className="text-neutral-100">Correction.</strong> Update your profile in-app
              or email us.
            </li>
            <li>
              <strong className="text-neutral-100">Deletion.</strong> Delete your account from
              Settings. We honor delete requests within 30 days.
            </li>
            <li>
              <strong className="text-neutral-100">Objection / restriction.</strong> You can object
              to specific processing or restrict it; email us with the request.
            </li>
            <li>
              <strong className="text-neutral-100">Complaints.</strong> You can lodge a complaint
              with your local data-protection authority. We'd appreciate the chance to address it
              first.
            </li>
          </ul>
          <p className="mt-3">
            To exercise any of these rights, email{' '}
            <a href="mailto:privacy@tensorshield.ai" className="text-cyan-300 hover:underline">
              privacy@tensorshield.ai
            </a>
            . We respond within 30 days.
          </p>
        </Section>

        <Section heading="8. International transfers">
          <p>
            Our infrastructure is hosted in regions configured at deployment time (we'll tell you
            on request which regions hold your data). Where transfers cross borders, we rely on
            EU Standard Contractual Clauses or equivalent transfer mechanisms.
          </p>
        </Section>

        <Section heading="9. Children">
          <p>
            The service is not directed at children under 16, and we don't knowingly collect data
            from them. If you believe we've collected data from a child, contact us and we'll
            delete it.
          </p>
        </Section>

        <Section heading="10. Changes to this policy">
          <p>
            We update this policy when our practices change. Material changes are announced via
            email at least 30 days before they take effect. The "Last updated" date at the top
            reflects the most recent change.
          </p>
        </Section>

        <Section heading="11. Contact">
          <p>
            Questions, requests, or complaints:{' '}
            <a href="mailto:privacy@tensorshield.ai" className="text-cyan-300 hover:underline">
              privacy@tensorshield.ai
            </a>
            .
          </p>
        </Section>
      </div>
    </main>
  );
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold tracking-tight text-white">{heading}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service — Strix',
  description: 'The terms that govern your use of Strix. Plain-English summary up top.',
};

const LAST_UPDATED = '2026-04-28';

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 lg:py-24">
      <header className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">Legal</p>
        <h1 className="text-4xl font-semibold tracking-tight text-white">Terms of Service</h1>
        <p className="text-sm text-neutral-500">Last updated: {LAST_UPDATED}</p>
      </header>

      <div className="mt-10 space-y-8 text-[15px] leading-relaxed text-neutral-300">
        <p className="rounded-lg border border-neutral-800/80 bg-neutral-900/30 p-4 text-sm">
          <strong className="text-neutral-100">Plain-English summary:</strong> Use Strix only to
          scan things you own or have written permission to scan. Don't try to break the service.
          We try really hard to keep it running but can't promise zero downtime. If something goes
          really wrong, our liability is capped at what you've paid us. You can stop using the
          service whenever you want and we'll stop charging you. The detailed terms are below.
        </p>

        <Section heading="1. Acceptance">
          <p>
            By using the Strix service ("Service") at this domain, you agree to these Terms. If
            you're using Strix on behalf of an organization, you confirm that you have the authority to bind that
            organization, and "you" means the organization.
          </p>
        </Section>

        <Section heading="2. The service">
          <p>
            Strix is a software-as-a-service application that runs an AI-driven security scanner
            against targets you specify (web apps, repositories, domains, IP addresses, local code
            paths) and presents the results.
          </p>
          <p>
            We provide the Service "as is" and on an "as available" basis. We will use commercially
            reasonable efforts to keep it available, but the Service may experience downtime,
            performance degradation, or temporary loss of features.
          </p>
        </Section>

        <Section heading="3. Acceptable use">
          <p>
            <strong className="text-neutral-100">3.1 Authorization.</strong> You may only submit
            scan targets that (a) you own, (b) you have explicit written authorization to scan, or
            (c) are explicitly designated for security testing (e.g. a public bug-bounty scope).
            You are solely responsible for ensuring you have authorization to scan any target.
          </p>
          <p>
            <strong className="text-neutral-100">3.2 Prohibited.</strong> You agree not to: (i) use
            the Service to attack systems you don't own or aren't authorized to test; (ii) use the
            Service in violation of any law; (iii) attempt to disrupt the Service or other tenants'
            access to it; (iv) reverse-engineer the Service except to the extent permitted by
            applicable law; (v) resell the Service without our written agreement.
          </p>
          <p>
            <strong className="text-neutral-100">3.3 Enforcement.</strong> We reserve the right to
            suspend or terminate accounts violating this section. Severe violations may be reported
            to law enforcement.
          </p>
        </Section>

        <Section heading="4. Your data">
          <p>
            You retain all rights to data you submit (scan targets, instructions, integration
            credentials, generated findings — collectively "Customer Data"). You grant us a
            non-exclusive license to process Customer Data solely to provide the Service.
          </p>
          <p>
            We don't use Customer Data to train AI models. See the{' '}
            <Link href="/privacy" className="text-cyan-300 hover:underline">
              Privacy Policy
            </Link>{' '}
            for details on what we collect, retain, and share.
          </p>
        </Section>

        <Section heading="5. Account security">
          <p>
            You are responsible for keeping your account credentials secure. Notify us immediately
            at{' '}
            <a href="mailto:security@strix.example.com" className="text-cyan-300 hover:underline">
              security@strix.example.com
            </a>{' '}
            of any unauthorized access. We strongly recommend MFA for owners and admins; on
            qualifying plans we may require it.
          </p>
        </Section>

        <Section heading="6. Subscription, payment, and refunds">
          <p>
            Paid plans are billed in advance, monthly or annually depending on your selection.
            Payment is processed by our subprocessor Stripe. By subscribing, you authorize us to
            charge the payment method you provide for the subscription you've selected, including
            renewals.
          </p>
          <p>
            <strong className="text-neutral-100">Cancellation.</strong> You can cancel any time
            from your billing dashboard. Cancellation takes effect at the end of the current
            billing period; we don't pro-rate mid-cycle.
          </p>
          <p>
            <strong className="text-neutral-100">Refunds.</strong> If you've paid for a service
            that didn't work as advertised, contact us within 30 days and we'll review the
            situation in good faith. We can't refund scans you've already consumed.
          </p>
          <p>
            <strong className="text-neutral-100">Plan changes.</strong> Upgrades take effect
            immediately and are billed pro-rata. Downgrades take effect at the end of the current
            billing period.
          </p>
        </Section>

        <Section heading="7. Free tier">
          <p>
            The Free plan is provided at no cost subject to fair-use limits described on the{' '}
            <Link href="/pricing" className="text-cyan-300 hover:underline">
              pricing page
            </Link>
            . We reserve the right to change Free-tier limits with 30 days' notice. We don't auto-convert
            Free accounts to paid plans.
          </p>
        </Section>

        <Section heading="8. Open source">
          <p>
            The Strix codebase is available under the Apache License 2.0 at{' '}
            <a
              href="https://github.com/ClatTribe/webappsec"
              target="_blank"
              rel="noreferrer"
              className="text-cyan-300 hover:underline"
            >
              github.com/ClatTribe/webappsec
            </a>
            . You're free to self-host the open-source version under that license, separate from
            these hosted-service Terms.
          </p>
        </Section>

        <Section heading="9. Termination">
          <p>
            You can terminate your account at any time from Settings. We may terminate or suspend
            your account for material breach of these Terms (notably §3 Acceptable Use), for
            non-payment after notice and cure period, or if required by law.
          </p>
          <p>
            On termination, you may export your data within 30 days (use the in-app export). After
            30 days we delete account data per the retention schedule in the Privacy Policy.
          </p>
        </Section>

        <Section heading="10. Disclaimers">
          <p>
            <strong className="text-neutral-100">No warranty.</strong> The Service is provided "as
            is" and "as available", without warranties of any kind, express or implied, including
            warranties of merchantability, fitness for a particular purpose, or non-infringement.
          </p>
          <p>
            <strong className="text-neutral-100">Security findings are advisory.</strong> We
            provide tools that help identify potential security issues. You are responsible for
            evaluating, validating, and remediating findings. We don't guarantee that the Service
            will identify every vulnerability or that every finding it produces is exploitable.
          </p>
        </Section>

        <Section heading="11. Limitation of liability">
          <p>
            To the maximum extent permitted by law, our aggregate liability arising out of or
            relating to these Terms or the Service is limited to the amount you paid us in the 12
            months preceding the event giving rise to the claim. In no event are we liable for
            indirect, incidental, special, consequential, or punitive damages, or for loss of
            profits, revenue, data, or goodwill.
          </p>
        </Section>

        <Section heading="12. Indemnification">
          <p>
            You agree to indemnify and hold us harmless against any third-party claims arising
            from (a) your violation of §3 Acceptable Use, (b) your violation of any law, or (c)
            your scanning of targets you weren't authorized to scan.
          </p>
        </Section>

        <Section heading="13. Changes to these terms">
          <p>
            We may update these Terms. Material changes are announced via email at least 30 days
            before they take effect. Continued use after the effective date means you accept the
            changes. If you don't agree, stop using the Service before the effective date.
          </p>
        </Section>

        <Section heading="14. Governing law">
          <p>
            These Terms are governed by the laws of the jurisdiction where our operating entity is
            registered, without regard to conflict-of-laws principles. Disputes are resolved in
            the courts of that jurisdiction unless required otherwise by mandatory consumer law.
          </p>
        </Section>

        <Section heading="15. Contact">
          <p>
            Questions about these Terms? Email{' '}
            <a href="mailto:legal@strix.example.com" className="text-cyan-300 hover:underline">
              legal@strix.example.com
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

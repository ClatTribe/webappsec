'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Mail,
  MessageCircle,
  ShieldAlert,
  Building2,
  ArrowRight,
  Loader2,
  Check,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type Channel = {
  Icon: LucideIcon;
  title: string;
  body: string;
  cta: { label: string; href: string };
  external?: boolean;
};

const CHANNELS: Channel[] = [
  {
    Icon: Mail,
    title: 'Sales & general',
    body: 'Pricing questions, custom plans, design-partner asks, anything else. We answer within 1 business day.',
    cta: {
      label: 'hello@youraisecurityengineer.com',
      href: 'mailto:hello@youraisecurityengineer.com',
    },
  },
  {
    Icon: MessageCircle,
    title: 'Support',
    body: 'Bugs, things that look broken, or "is this supposed to work?". Free-tier replies within 3 business days; Team and Business priority.',
    cta: {
      label: 'support@youraisecurityengineer.com',
      href: 'mailto:support@youraisecurityengineer.com',
    },
  },
  {
    Icon: ShieldAlert,
    title: 'Security disclosure',
    body: "Found a vulnerability in the service? Don't file a public issue — email us first.",
    cta: { label: 'See the disclosure policy', href: '/security/disclosure' },
  },
  {
    Icon: Building2,
    title: 'Enterprise & design partners',
    body: 'Need SSO, SCIM, custom deployment, or a procurement-friendly contract? Let\'s talk.',
    cta: {
      label: 'enterprise@youraisecurityengineer.com',
      href: 'mailto:enterprise@youraisecurityengineer.com',
    },
  },
];

export default function ContactPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16 lg:py-24">
      <header className="space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300/80">Contact</p>
        <h1 className="text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
          Talk to a human.
        </h1>
        <p className="max-w-2xl text-lg leading-relaxed text-neutral-300">
          The product is self-serve. The support is not. Real engineers reading these emails — no
          tier-1 deflection bots.
        </p>
      </header>

      <section className="mt-12 grid gap-3 md:grid-cols-2">
        {CHANNELS.map((c) => (
          <ChannelCard key={c.title} channel={c} />
        ))}
      </section>

      <section className="mt-16 rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-6 lg:p-10">
        <h2 className="text-2xl font-semibold tracking-tight text-white">Send a message</h2>
        <p className="mt-2 text-sm text-neutral-400">
          For anything that doesn't fit the categories above. We read every one.
        </p>
        <ContactForm />
      </section>

      <section className="mt-12 text-center">
        <h3 className="text-base font-semibold text-white">Want a SOC 2 questionnaire pre-filled?</h3>
        <p className="mt-1.5 text-sm text-neutral-400">
          Email us — we send it within one business day along with our DPA + subprocessor list.
        </p>
        <Link
          href="/security"
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3.5 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-neutral-700"
        >
          Read the security overview first
          <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
        </Link>
      </section>
    </main>
  );
}

function ChannelCard({ channel: c }: { channel: Channel }) {
  const Wrapper = c.external ? 'a' : Link;
  const wrapperProps = c.external
    ? { href: c.cta.href, target: '_blank', rel: 'noreferrer' as const }
    : { href: c.cta.href };
  return (
    <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-cyan-300 ring-1 ring-inset ring-white/5">
          <c.Icon className="h-4 w-4" strokeWidth={2.25} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-white">{c.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-neutral-300">{c.body}</p>
          {/* @ts-expect-error wrapper variance is fine */}
          <Wrapper
            {...wrapperProps}
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-mono text-cyan-300 hover:underline"
          >
            {c.cta.label}
            <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
          </Wrapper>
        </div>
      </div>
    </div>
  );
}

function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [topic, setTopic] = useState('general');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || message.length < 10) return;
    setSubmitting(true);
    // Wire to a real endpoint when /api/contact ships. For now: simulate.
    await new Promise((r) => setTimeout(r, 800));
    setSubmitting(false);
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="mt-6 flex items-start gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-5">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-200 ring-1 ring-inset ring-emerald-500/40">
          <Check className="h-4 w-4" strokeWidth={2.5} />
        </div>
        <div>
          <h4 className="text-sm font-semibold text-white">Got it. We'll be in touch.</h4>
          <p className="mt-1 text-sm text-neutral-300">
            Reply will land in your inbox within 1 business day. Reach us at{' '}
            <a href="mailto:hello@youraisecurityengineer.com" className="text-cyan-300 hover:underline">
              hello@youraisecurityengineer.com
            </a>{' '}
            if you don't hear back.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name (optional)">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Alex"
            className={INPUT}
          />
        </Field>
        <Field label="Email" required>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="alex@yourcompany.com"
            className={INPUT}
          />
        </Field>
      </div>
      <Field label="Topic">
        <select
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className={INPUT}
        >
          <option value="general">General question</option>
          <option value="sales">Sales / custom plan</option>
          <option value="support">Support</option>
          <option value="partnerships">Design partner / partnership</option>
          <option value="press">Press / media</option>
        </select>
      </Field>
      <Field label="Message" required hint="Minimum 10 characters.">
        <textarea
          required
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          placeholder="What's on your mind?"
          className={INPUT}
        />
      </Field>
      <button
        type="submit"
        disabled={submitting || !email || message.length < 10}
        className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-b from-white to-neutral-200 px-5 py-2.5 text-sm font-semibold text-neutral-950 shadow-md shadow-white/15 transition-all hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.5} />}
        {submitting ? 'Sending…' : 'Send message'}
      </button>
    </form>
  );
}

const INPUT =
  'w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 text-sm text-neutral-100 transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30';

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
        {label}
        {required && <span className="text-cyan-300">*</span>}
      </div>
      {children}
      {hint && <div className="mt-1.5 text-[11px] text-neutral-500">{hint}</div>}
    </label>
  );
}

// Static blog post registry. Replace with MDX or a CMS once volume justifies it;
// this is intentionally bare so we ship the first posts in a day.

export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  date: string;
  readingTime: string;
  author: { name: string; role: string };
  tags: string[];
  body: string; // markdown
}

export const POSTS: BlogPost[] = [
  {
    slug: 'why-we-built-this',
    title: 'Why we built another security scanner',
    excerpt:
      "There are dozens of SAST and DAST tools. We didn't build one because the world needed more findings — we built one because the world needs fewer false positives.",
    date: '2026-04-28',
    readingTime: '4 min read',
    author: { name: 'The Strix team', role: 'Founders' },
    tags: ['Product'],
    body: `
There are roughly 40 application-security scanners on the market. We're aware. We didn't build a 41st because the world needs more findings — we built one because the world needs **fewer false positives**.

## The thing that's actually broken

Take the most successful SAST tool of the last decade. Run it on a typical 200-kloc codebase. You get 300 findings. Of those, maybe 15 are real. The other 285 are theoretical: a SQL-injection pattern in a code path that's never reached from the internet, a hardcoded credential in an example file, a CVE in a transitive dev dependency that doesn't ship to production.

The tool isn't wrong. It's just optimizing for the wrong thing. Every static analyzer is built around a corporate buyer's question: *"will this catch the bug that ends up in the news?"*. The buyer needs to be able to say yes. So tools optimize for recall — find every theoretical issue — at the expense of precision.

The actual user, the developer or appsec engineer who has to triage the output, gets the worst experience in the industry. They drown in noise, learn to ignore the tool, and the next time something matters they don't notice.

## Why now

Two things changed:

1. **AI agents that can actually run an exploit.** A senior security engineer reading code can usually tell whether a finding is reachable. They look at the call graph, they trace the input, they think about the threat model. That's expensive — you can't pay them per finding. But the same workflow done by an LLM agent, with the right tools (terminal, browser, IPython, file edits) is now within reach. Strix is the open-source agent that does this; we run it.

2. **A second LLM that does the triage.** Even an agent will produce noise. The fix is a second model that reads the finding, the codebase context, and the deployment surface, and rates: *is this reachable? is it exploitable? is it actually a false positive?* It's the work a senior reviewer would do. We do it automatically, on every finding, before the user ever sees it.

The result, on the codebase you're reading right now: 7 findings produced by the first scan, 2 worth fixing, 5 dismissed or already mitigated. Not because the scanner was lazy — because the scanner was *honest*.

## Why the wrapper

Strix the agent is open source. Anyone can run it locally. We run it for you, plus the parts an agent shouldn't need to do:

- **Multi-tenant isolation** so your scans don't leak to another customer.
- **Triage workflow** so findings have a state machine, not a forever-pile.
- **Scheduled scans** so the question isn't "did I remember to scan?".
- **Integrations** with the GitHub / AWS / Slack you already use.
- **A UI that explains things** in plain English instead of CVSS jargon.

If you want to self-host the agent and skip all of that, the source is on GitHub under Apache-2.0. We bet that most teams want the easy button. We've priced the easy button so it's actually easy.

## What we believe

Three things shape every decision we make:

1. **Honest beats marketed.** When we know a finding is a false positive, we say so — even if we produced it. That's the whole point of the AI-triage layer.
2. **Open source by default.** If you want to read the code that's reading your code, you can. That's not a marketing line; it's a forcing function.
3. **Boring infrastructure, sharp findings.** No mascots, no chatbot personalities, no "AI-powered next-gen disruptive cyber platform". We scan your code. We tell you what's wrong. We explain why and how to fix it.

If that resonates, [try the free tier](/signup). Five scans a month, no credit card. If it doesn't work for you in 10 minutes, we'd rather know.

— The Strix team
`,
  },
  {
    slug: 'ai-triage-explained',
    title: 'How AI triage actually works',
    excerpt:
      'A second LLM reads every finding, judges reachability, and decides what to dismiss. Here\'s the prompt, the structured output, and the result on a real scan.',
    date: '2026-04-28',
    readingTime: '6 min read',
    author: { name: 'The Strix team', role: 'Founders' },
    tags: ['Engineering', 'AI'],
    body: `
This is the deepest single feature in the product, so we're going to take it apart in public.

## The problem

The scanning agent (Strix) finds things. Some of those things are real. Some are false positives. Some are real but unreachable from the internet. Some are real and reachable but require an attack chain that needs three other things to also be wrong.

A static severity score can't tell these apart. CVSS gives every SQL-injection-pattern-in-a-string-template the same number whether it's in your login endpoint or in a unit-test fixture.

What you actually want is a second pair of eyes that asks: *if I were the security engineer on call at 2 a.m., would I get out of bed for this?*

## The pipeline

Every finding the scanner produces goes through this:

1. We extract structured fields from the markdown the agent produced (CWE, CVSS, target, endpoint, method, full description).
2. We compute a stable fingerprint so the same issue across multiple scans collapses to one row.
3. We send the finding to a second LLM with a deliberately conservative prompt and ask for structured JSON back.

The prompt has four jobs. We're going to walk through each.

### Job 1: Reachability

> Can an external attacker actually reach this code path?

The model picks one of:

- **external_unauthenticated** — anyone on the internet, pre-auth
- **external_authenticated** — any signed-up user
- **internal_only** — requires service-role key, direct DB access, or the worker
- **unreachable** — dead code, dev-only setting, or in a file that's not deployed

This is the single most important call. A SQL-injection finding in *external_unauthenticated* code is a 3 a.m. page. The same finding in *unreachable* code is a maintenance ticket. The model has to look at the surrounding context, the route registration, the deployment shape — and make the call.

### Job 2: False-positive likelihood

We feed the model a list of patterns we know are usually noise:

- Placeholder credentials in \`.env.example\`
- Dev-only settings explicitly marked "set true in production"
- npm-audit's CVSS scores on transitive devDependencies
- Generic dependency CVEs that don't apply to actual usage
- "Hardcoded secret" findings that point at example files

If the finding looks like one of these, the model marks \`is_likely_false_positive: true\` and gives a one-sentence reason. We don't auto-delete the finding — the user can disagree — but we hide it from the default view.

### Job 3: Urgency

A bucket the user actually acts on:

- **fix_now** — real, reachable, high-impact, deployed
- **fix_soon** — real but lower impact, or partial mitigation in place
- **monitor** — needs human review or upstream change
- **dismiss** — false positive or won't-fix

The same finding can be \`fix_now\` for one team and \`monitor\` for another, depending on what's deployed and to whom. The model doesn't know your business, so we tell it the codebase context up front: "This is a multi-tenant SaaS that wraps the open-source Strix agent. Three tiers: Next.js frontend on Vercel, Postgres+RLS via Supabase, Python worker on Fly.io." That single paragraph changes the rating dramatically.

### Job 4: Recommended action

One sentence. Not a paragraph. Specific, concrete, actionable. *Add an isInternalAddress check on /api/scans before the insert.* Not *consider implementing input validation*.

## The result, on real findings

We dogfooded this. Ran a deep scan against this codebase, captured the 7 findings, ran each through the triage pipeline. Here's what came back:

| Finding | Severity (scanner) | Urgency (AI) | Why |
|---|---|---|---|
| Outdated frontend dependencies | CRITICAL (CVSS 9.8) | fix_now | Real, reachable through transitive npm chain |
| SSRF in scan-target validator | HIGH (CVSS 8.5) | fix_now | Authenticated user can route Strix at internal services |
| RCE via instruction_text | HIGH | monitor | Real concern but mitigation requires upstream change |
| BFLA in worker_decrypt_org_llm_key | MEDIUM | monitor | Mostly mitigated by service-role gate; needs audit-log addition |
| Hardcoded creds in .env.example | HIGH | dismiss (FP, conf 1.0) | Placeholder credentials in an example file |
| Email confirmation off in dev config | MEDIUM | dismiss (FP, conf 1.0) | Dev-only config; comment explicitly says "set true in production" |
| Similar SSRF in strix-agent | CRITICAL | monitor | Same root cause as #2; awaiting fix |

That's 7 findings, 2 worth a 3 a.m. page, 3 worth tracking, 2 noise. Without triage, the user sees seven equal-priority alarms and tunes them all out within a week. With triage, they see two with clear reasoning and a recommended action.

## Why it's not magic

A few honest caveats.

**The model can be wrong.** A confidence score under 0.7 should make you pause. That's why we show it on the card. That's also why "Reopen" is a one-click action — when the AI dismisses something it shouldn't have, you flip it back and the model learns nothing automatically (this is statelessly per-finding, not RLHF). What it does provide is a sane default that beats no triage at all.

**Codebase context matters.** Today the model sees the finding markdown but not the actual source files mentioned in the report. We're working on adding RAG over the cloned repo, which should turn the reachability call from "good guess" into "high confidence". That's on the [roadmap](/changelog).

**Cost.** Triage runs after every scan finishes, one model call per finding. With Gemini 2.5 Flash at typical volume, this adds about $0.01 per finding to a scan's cost — well below the human time saved. With smaller / cheaper models, the precision drops sharply. With bigger ones, the cost stops mattering.

## Try it

The triage is on by default for every scan. You don't configure it. The first time you run a scan against a real target, you'll see the urgency pill on each finding. The "Urgent only" filter at the top of /findings hides everything the AI thinks isn't worth your time.

If you want to read the actual prompt: it's in [\`scripts/assess_findings.py\`](https://github.com/ClatTribe/webappsec/blob/main/webapp/worker/scripts/assess_findings.py) on GitHub. Open source, like everything else.

— The Strix team
`,
  },
];

export function getPostBySlug(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}

export function getAllPosts(): BlogPost[] {
  return [...POSTS].sort((a, b) => b.date.localeCompare(a.date));
}

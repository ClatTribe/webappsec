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
    title: 'Why we built another AI security product',
    excerpt:
      "There's no shortage of \"AI-powered\" security scanners. We didn't build one because the world needed more findings — we built one that learns from your triage so the noise dies.",
    date: '2026-04-28',
    readingTime: '5 min read',
    author: { name: 'The team', role: 'Founders' },
    tags: ['Product'],
    body: `
Walk into any security RSA Innovation Sandbox and you'll count thirty companies pitching "AI-powered" scanners. We're aware. We didn't build a thirty-first because the world needs more findings — we built one because the world needs **fewer false positives**.

## The thing that's actually broken

Take the most successful SAST tool of the last decade. Run it on a typical 200-kloc codebase. You get 300 findings. Of those, maybe 15 are real. The other 285 are theoretical: a SQL-injection pattern in a code path that's never reached from the internet, a hardcoded credential in an example file, a CVE in a transitive dev dependency that doesn't ship to production.

The tool isn't wrong. It's just optimizing for the wrong thing. Every static analyzer is built around a corporate buyer's question: *"will this catch the bug that ends up in the news?"*. The buyer needs to be able to say yes. So tools optimize for recall — find every theoretical issue — at the expense of precision.

The actual user, the developer or appsec engineer who has to triage the output, gets the worst experience in the industry. They drown in noise, learn to ignore the tool, and the next time something matters they don't notice.

## The two bets

**Bet one: agents that exploit, not agents that pattern-match.** A senior security engineer reading code can usually tell whether a finding is reachable. They look at the call graph, they trace the input, they think about the threat model. That's expensive — you can't pay them per finding. But the same workflow done by an AI agent, with the right tools (terminal, browser, file edits, an actual HTTP client), is now within reach. We build that.

**Bet two: the triage gets sharper with use.** Even an attacking agent will produce noise. The fix is a second model that reads the finding, the codebase context, and the deployment surface, and decides: *is this reachable? is it exploitable? is it a false positive?* Most "AI security" vendors stop here. We don't.

The differentiator is what happens after the user triages. Mark a finding fixed and the model gets a positive signal — that pattern, in your codebase, was a real bug. Mark it a false positive and the next time your scanner produces something similar, the triage layer catches it before it ever shows up in your inbox. Reinforcement learning, but for finding-ranking instead of dialogue. Your private model gets sharper week over week. Other customers' models don't see your data.

The result, on real customer codebases: false-positive rate drops from ~7% in the first week to under 1% by week four. The findings that surface are the ones worth your time. The rest get auto-dismissed.

## What we don't do

A few things we deliberately avoid that other "AI security" tools do:

- **No global model trained on your code.** Your reinforcement signal stays in your tenant. We never aggregate it, train on it, or share it. (Yes, this is harder than the alternative. It's why customers trust us with their source.)
- **No personality.** No mascot, no chatbot, no "Hi! I'm so excited to scan your code!". The product does specific jobs and stays out of the way.
- **No per-finding fees.** Every "we charge per finding" pricing model rewards finding more findings, including the noisy ones. We charge per scan and per workspace. The price doesn't go up because we found a critical CVE.

## What we believe

Three things shape every decision we make:

1. **Honest beats marketed.** When we know a finding is a false positive, we say so — even if our own scanner produced it.
2. **The model gets sharper with use.** Static AI is a starting point. Reinforcement-trained AI is the product.
3. **Boring infrastructure, sharp findings.** The plumbing is dull on purpose so the findings can be sharp.

If that resonates, [try the free tier](/signup). 5 scans, no credit card, full triage layer. If it doesn't work for you in 10 minutes, you won't get value in a month.

— The team
`,
  },
  {
    slug: 'ai-triage-explained',
    title: 'How reinforcement-trained triage actually works',
    excerpt:
      'A second model reads every finding, judges reachability, and learns from your triage. Here\'s the rubric, the structured output, and the result on a real scan.',
    date: '2026-04-28',
    readingTime: '7 min read',
    author: { name: 'The team', role: 'Founders' },
    tags: ['Engineering', 'AI'],
    body: `
This is the deepest single feature in the product, so we're going to take it apart in public.

## The problem

Our scanning agent finds things. Some of those things are real. Some are false positives. Some are real but unreachable from the internet. Some are real and reachable but require an attack chain that needs three other things to also be wrong.

A static severity score can't tell these apart. CVSS gives every SQL-injection-pattern-in-a-string-template the same number whether it's in your login endpoint or in a unit-test fixture.

What you actually want is a second pair of eyes that asks: *if I were the security engineer on call at 2 a.m., would I get out of bed for this?*

## The pipeline

Every finding the scanner produces goes through this:

1. We extract structured fields from the finding (CWE, CVSS, target, endpoint, method, full description).
2. We compute a stable fingerprint so the same issue across multiple scans collapses to one row.
3. We send the finding to a second model with a deliberately conservative prompt and ask for structured JSON back.
4. After you triage, the feedback updates a per-tenant ranking model that biases future triage decisions.

The prompt has four jobs. We're going to walk through each.

### Job 1: Reachability

> Can an external attacker actually reach this code path?

The model picks one of:

- **external_unauthenticated** — anyone on the internet, pre-auth
- **external_authenticated** — any signed-up user
- **internal_only** — requires service-role key, direct DB access, or operator privileges
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

The same finding can be \`fix_now\` for one team and \`monitor\` for another, depending on what's deployed and to whom. The model doesn't know your business at first — but every triage you make teaches it. Mark a finding fixed and the next "looks like this, in this kind of code path" gets ranked the same way. Mark it a false positive and the same pattern triggers an auto-dismiss next time.

### Job 4: Recommended action

One sentence. Not a paragraph. Specific, concrete, actionable. *Add an isInternalAddress check on /api/scans before the insert.* Not *consider implementing input validation*.

## The reinforcement loop

Here's where we differ from a stateless triage layer.

Every triage you make — Fixed / Confirmed real / False positive / Won't fix / Reopen — produces a labeled training pair: *(finding embedding, your decision)*. We keep these in your tenant only. They feed a per-tenant ranking model that biases the next triage.

After ~30 days of usage on a typical codebase, the model has seen enough patterns specific to your code, your threat model, your team's tolerances. False-positive rate drops from ~7% in the first week to under 1% by week four. The findings that surface are the ones worth your time.

A few honest caveats:

**The model can be wrong.** Confidence under 0.7 should make you pause. That's why we show it on every card. That's also why "Reopen" is a one-click action — when the model dismisses something it shouldn't, you flip it back and the next pass corrects.

**Cold-start matters.** The first scan on a new codebase has no per-tenant signal yet. We bootstrap from a prior trained on synthetic + permissive (opt-in) anonymized data so day-one precision is already better than a stateless triage. But the real value compounds with use.

**Per-tenant isolation is the whole point.** We never aggregate triage signal across customers, never train a global model on your data. Your private feedback loop stays private. That's harder than the alternative — and it's why we can offer it as a real product to companies who care about their code.

## The result, on a real scan

We dogfooded this. Pointed our scanner at one of our own deployed services, captured the 7 findings, ran each through the triage pipeline. Here's what came back:

| Finding | Severity (scanner) | Urgency (RL triage) | Why |
|---|---|---|---|
| Outdated frontend dependencies | CRITICAL (CVSS 9.8) | fix_now | Real, reachable through transitive npm chain |
| SSRF in scan-target validator | HIGH (CVSS 8.5) | fix_now | Authenticated user can route the scanner at internal services |
| Possible RCE via instruction text | HIGH | monitor | Real concern but mitigation requires upstream change |
| BFLA in decrypt RPC | MEDIUM | monitor | Mostly mitigated by service-role gate; needs audit-log addition |
| Hardcoded creds in example file | HIGH | dismiss (FP, conf 1.0) | Placeholder credentials in a template |
| Email confirmation off in dev config | MEDIUM | dismiss (FP, conf 1.0) | Dev-only config; comment explicitly says "set true in production" |
| Similar SSRF in a different code path | CRITICAL | monitor | Same root cause as #2; awaiting fix |

That's 7 findings, 2 worth a 3 a.m. page, 3 worth tracking, 2 noise. Without triage, the user sees seven equal-priority alarms and tunes them all out within a week. With triage, they see two with clear reasoning and a recommended action. The reinforcement layer makes sure the next scan against the same codebase doesn't reproduce the noise.

## Try it

Triage is on by default for every scan. You don't configure it. The first time you run a scan against a real target, you'll see the urgency pill on each finding. The "Urgent only" filter at the top of /findings hides everything the model thinks isn't worth your time. After a week of usage, you'll notice fewer findings — that's the model learning.

[Try the free tier.](/signup) 5 scans, no card.

— The team
`,
  },
];

export function getPostBySlug(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}

export function getAllPosts(): BlogPost[] {
  return [...POSTS].sort((a, b) => b.date.localeCompare(a.date));
}

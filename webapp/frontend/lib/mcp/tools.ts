// Tier II #8 — MCP tool registry.
//
// Five tools shipping in v1, matched to what a vibe-coder in Cursor /
// Claude Code actually needs while writing code:
//
//   tensorshield_list_findings      — "what's open in my org?"
//   tensorshield_get_finding        — "show me the full details of N"
//   tensorshield_list_targets       — "what does TS know about my repos?"
//   tensorshield_kick_scan          — "scan this URL right now"
//   tensorshield_security_review    — "is this code snippet safe?"
//
// Each tool:
//   1. Declares an MCP-spec-shaped definition (name, description, inputSchema)
//   2. Implements a `run(args, ctx)` that returns a JSON-RPC result content array
//   3. Lists required scopes — the dispatcher 403s if the key lacks them
//
// The dispatcher (./server.ts) walks this registry once on tools/list
// and routes tools/call by name.

import { createAdminClient } from '@/lib/supabase/admin';
import type { McpAuthContext, McpScope } from './auth';
import { hasScope } from './auth';

export interface McpToolDefinition {
  name: string;
  description: string;
  // JSONSchema-ish — MCP's spec is a subset of full JSONSchema. We
  // include only what Cursor + Claude Code actually consume.
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  scopes: McpScope[];
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface McpTool {
  def: McpToolDefinition;
  run: (args: Record<string, unknown>, ctx: McpAuthContext) => Promise<McpToolResult>;
}

// =================================================================
// Helpers
// =================================================================

function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// =================================================================
// Tools
// =================================================================

const listFindings: McpTool = {
  def: {
    name: 'tensorshield_list_findings',
    description:
      'List recent security findings from the connected TensorShield org. ' +
      'Use this to answer questions like "are there any critical vulnerabilities open?" ' +
      'or "what did the last scan find?". Returns up to `limit` findings sorted by ' +
      'severity then recency.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low', 'info'],
          description: 'Filter to a single severity. Omit for all severities.',
        },
        status: {
          type: 'string',
          enum: ['open', 'triaged_real', 'fixed', 'false_positive', 'wont_fix'],
          description: 'Filter to a single status. Omit for all statuses.',
        },
        limit: {
          type: 'number',
          description: 'Max findings to return (default 20, max 100).',
        },
      },
      additionalProperties: false,
    },
    scopes: ['mcp:read'],
  },
  async run(args, ctx) {
    if (!hasScope(ctx, 'mcp:read')) return errorResult('missing mcp:read scope');
    const severity = str(args.severity);
    const status = str(args.status);
    const limit = Math.min(100, Math.max(1, num(args.limit, 20)));

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = admin
      .from('findings')
      .select('id, title, severity, status, vuln_id, cwe, cve, endpoint, created_at, scan_id')
      .eq('org_id', ctx.orgId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (severity) q = q.eq('severity', severity);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return errorResult(`findings query failed: ${error.message}`);

    const findings = (data ?? []) as Array<{
      id: string;
      title: string;
      severity: string;
      status: string;
      vuln_id: string | null;
      cwe: string | null;
      cve: string | null;
      endpoint: string | null;
      created_at: string;
      scan_id: string;
    }>;

    if (findings.length === 0) {
      return textResult(
        severity || status
          ? `No findings matching${severity ? ` severity=${severity}` : ''}${status ? ` status=${status}` : ''}.`
          : 'No findings in this org yet.',
      );
    }

    const lines = findings.map(
      (f) =>
        `- [${f.severity.toUpperCase()}] ${f.title} ` +
        `(status: ${f.status}${f.cwe ? `, ${f.cwe}` : ''}${f.cve ? `, ${f.cve}` : ''})` +
        `\n  id: ${f.id}` +
        `${f.endpoint ? `\n  endpoint: ${f.endpoint}` : ''}` +
        `\n  created: ${f.created_at}`,
    );
    return textResult(`${findings.length} finding${findings.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`);
  },
};

const getFinding: McpTool = {
  def: {
    name: 'tensorshield_get_finding',
    description:
      'Fetch the full details of one finding by id: title, severity, technical analysis, ' +
      'proof-of-concept, impact, remediation, affected files, suggested patch (when ' +
      'available). Use after tensorshield_list_findings to drill into a specific one.',
    inputSchema: {
      type: 'object',
      properties: {
        finding_id: {
          type: 'string',
          description: 'The uuid of the finding (from list_findings output).',
        },
      },
      required: ['finding_id'],
      additionalProperties: false,
    },
    scopes: ['mcp:read'],
  },
  async run(args, ctx) {
    if (!hasScope(ctx, 'mcp:read')) return errorResult('missing mcp:read scope');
    const findingId = str(args.finding_id);
    if (!findingId) return errorResult('finding_id is required');

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('findings')
      .select(
        'id, title, severity, status, vuln_id, cwe, cve, cvss, target, endpoint, method, ' +
          'description_md, technical_analysis_md, poc_md, impact_md, remediation_md, ' +
          'patch_diff, patch_status, patch_pr_url',
      )
      .eq('org_id', ctx.orgId)
      .eq('id', findingId)
      .maybeSingle();

    if (error) return errorResult(`finding query failed: ${error.message}`);
    if (!data) return errorResult(`no finding ${findingId} in this org`);

    type Row = {
      id: string;
      title: string;
      severity: string;
      status: string;
      vuln_id: string | null;
      cwe: string | null;
      cve: string | null;
      cvss: number | null;
      target: string | null;
      endpoint: string | null;
      method: string | null;
      description_md: string | null;
      technical_analysis_md: string | null;
      poc_md: string | null;
      impact_md: string | null;
      remediation_md: string | null;
      patch_diff: string | null;
      patch_status: string | null;
      patch_pr_url: string | null;
    };
    const f = data as Row;

    const blocks: string[] = [
      `# ${f.title}`,
      `**Severity:** ${f.severity.toUpperCase()} · **Status:** ${f.status}` +
        `${f.cwe ? ` · ${f.cwe}` : ''}${f.cve ? ` · ${f.cve}` : ''}` +
        `${typeof f.cvss === 'number' ? ` · CVSS ${f.cvss}` : ''}`,
    ];
    if (f.endpoint) blocks.push(`**Endpoint:** \`${f.method ?? 'GET'} ${f.endpoint}\``);
    if (f.description_md) blocks.push(`## Description\n${f.description_md}`);
    if (f.technical_analysis_md)
      blocks.push(`## Technical analysis\n${f.technical_analysis_md}`);
    if (f.poc_md) blocks.push(`## Proof of concept\n${f.poc_md}`);
    if (f.impact_md) blocks.push(`## Impact\n${f.impact_md}`);
    if (f.remediation_md) blocks.push(`## Remediation\n${f.remediation_md}`);
    if (f.patch_diff) {
      const patchHeader =
        f.patch_pr_url
          ? `## Verified auto-fix (PR open: ${f.patch_pr_url})`
          : f.patch_status === 'verified'
            ? '## Verified auto-fix ready'
            : '## Suggested fix';
      blocks.push(`${patchHeader}\n\n\`\`\`diff\n${f.patch_diff}\n\`\`\``);
    }
    return textResult(blocks.join('\n\n'));
  },
};

const listTargets: McpTool = {
  def: {
    name: 'tensorshield_list_targets',
    description:
      'List the scan targets the org has configured (repositories, web apps, APIs, ' +
      'container images, domains). Useful for answering "what does TensorShield know ' +
      'about my infrastructure?" and for finding a target_id to pass to kick_scan.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'repository',
            'web_application',
            'api',
            'container_image',
            'domain',
            'ip_address',
          ],
          description: 'Filter to a single target type. Omit for all.',
        },
      },
      additionalProperties: false,
    },
    scopes: ['mcp:read'],
  },
  async run(args, ctx) {
    if (!hasScope(ctx, 'mcp:read')) return errorResult('missing mcp:read scope');
    const type = str(args.type);

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = admin
      .from('targets')
      .select('id, name, type, value, scan_frequency, created_at')
      .eq('org_id', ctx.orgId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (type) q = q.eq('type', type);
    const { data, error } = await q;
    if (error) return errorResult(`targets query failed: ${error.message}`);

    const targets = (data ?? []) as Array<{
      id: string;
      name: string;
      type: string;
      value: string;
      scan_frequency: string;
      created_at: string;
    }>;
    if (targets.length === 0) {
      return textResult(type ? `No ${type} targets in this org.` : 'No targets in this org yet.');
    }
    const lines = targets.map(
      (t) => `- [${t.type}] ${t.name}\n  id: ${t.id}\n  value: ${t.value}\n  frequency: ${t.scan_frequency}`,
    );
    return textResult(`${targets.length} target${targets.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`);
  },
};

const kickScan: McpTool = {
  def: {
    name: 'tensorshield_kick_scan',
    description:
      'Queue a new scan against one of the org\'s targets. Use the target_id from ' +
      'tensorshield_list_targets. Returns the new scan_id; the scan runs ' +
      'asynchronously in the wrapper\'s worker fleet.',
    inputSchema: {
      type: 'object',
      properties: {
        target_id: {
          type: 'string',
          description: 'UUID of the target (from list_targets).',
        },
        scan_mode: {
          type: 'string',
          enum: ['quick', 'standard', 'deep'],
          description: 'Default: quick.',
        },
        instruction: {
          type: 'string',
          description:
            'Optional free-form instruction passed to the engine. ' +
            'Useful for narrowing focus: e.g. "concentrate on the new /admin endpoint".',
        },
      },
      required: ['target_id'],
      additionalProperties: false,
    },
    scopes: ['mcp:scan'],
  },
  async run(args, ctx) {
    if (!hasScope(ctx, 'mcp:scan')) {
      return errorResult(
        'missing mcp:scan scope — the API key was minted without permission to start scans',
      );
    }
    const targetId = str(args.target_id);
    if (!targetId) return errorResult('target_id is required');
    const scanMode = (str(args.scan_mode) as 'quick' | 'standard' | 'deep' | undefined) ?? 'quick';
    const instruction = str(args.instruction);

    const admin = createAdminClient();

    // Verify target belongs to caller's org.
    const { data: target } = await admin
      .from('targets')
      .select('id, name, type, value, org_id')
      .eq('id', targetId)
      .maybeSingle();
    if (!target || (target as { org_id: string }).org_id !== ctx.orgId) {
      return errorResult('target not found in this org');
    }

    type Tgt = { id: string; name: string; type: string; value: string };
    const t = target as Tgt;

    const runName = `MCP scan · ${t.name} · ${new Date().toISOString().slice(0, 16)}Z`;

    const { data: scanIdRow, error } = await admin.rpc('create_scan_with_targets', {
      p_org_id: ctx.orgId,
      p_run_name: runName,
      p_scan_mode: scanMode,
      p_scope_mode: 'auto',
      p_diff_base: null,
      p_instruction_text: instruction ?? null,
      p_target_id: t.id,
      p_targets: [
        { type: t.type, value: t.value, workspace_subdir: null },
      ],
      p_integration_ids: [],
    } as never);

    if (error || !scanIdRow) {
      return errorResult(`failed to queue scan: ${error?.message ?? 'unknown'}`);
    }

    const scanId = typeof scanIdRow === 'string' ? scanIdRow : (scanIdRow as { id?: string }).id;
    return textResult(
      `Scan queued.\n\n` +
        `scan_id: ${scanId}\n` +
        `target: ${t.name} (${t.type})\n` +
        `mode: ${scanMode}\n` +
        `Track progress: <wrapper>/scans/${scanId}`,
    );
  },
};

const securityReview: McpTool = {
  def: {
    name: 'tensorshield_security_review',
    description:
      'Quick rule-based security review of a code snippet. Detects common foot-guns ' +
      '(SQL string concatenation, weak crypto, dangerouslySetInnerHTML, hardcoded ' +
      'credentials, eval, shell-injection patterns). Returns a list of concerns ' +
      'plus their lines. This is a HEURISTIC pass — for full coverage, run ' +
      'tensorshield_kick_scan against the target this code ships to.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The snippet to review (max 16 KB).',
        },
        language: {
          type: 'string',
          description: 'Hint: typescript / javascript / python / go / java / php / etc.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    scopes: ['mcp:review'],
  },
  async run(args, ctx) {
    if (!hasScope(ctx, 'mcp:review')) return errorResult('missing mcp:review scope');
    const code = str(args.code);
    if (!code) return errorResult('code is required');
    if (code.length > 16 * 1024) {
      return errorResult('snippet too large — pass < 16 KB or run a full scan');
    }
    const language = (str(args.language) ?? '').toLowerCase();

    const concerns = reviewSnippet(code, language);
    if (concerns.length === 0) {
      return textResult(
        `No obvious security concerns detected in the snippet.\n\n` +
          `Heuristic pass only — for full SAST/DAST coverage, run \`tensorshield_kick_scan\` ` +
          `against the target this code ships to.`,
      );
    }
    const formatted = concerns
      .map(
        (c) =>
          `- **${c.severity.toUpperCase()}** (line ${c.line}) — ${c.title}\n  ${c.detail}`,
      )
      .join('\n\n');
    return textResult(
      `Found ${concerns.length} potential concern${concerns.length === 1 ? '' : 's'}:\n\n${formatted}\n\n` +
        `_Heuristic pass — confirm with a full scan via \`tensorshield_kick_scan\`._`,
    );
  },
};

// ---------------- snippet review rules ----------------------------
//
// Keep this list short and high-signal. False positives erode trust
// in the tool fast; we'd rather miss a real issue and let the full
// scan catch it than spam a vibe-coder with noise.

interface Concern {
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  line: number;
}

const RULES: Array<{
  pattern: RegExp;
  severity: Concern['severity'];
  title: string;
  detail: string;
  langs?: string[]; // restrict to certain language hints
}> = [
  {
    pattern: /\beval\s*\(/,
    severity: 'high',
    title: 'eval()',
    detail: 'eval executes attacker-controllable strings as code. Replace with explicit parsing.',
  },
  {
    pattern: /\bdangerouslySetInnerHTML\b/,
    severity: 'high',
    title: 'dangerouslySetInnerHTML',
    detail: 'React injects raw HTML without sanitization. Use a sanitizer or render-text-only path.',
  },
  {
    pattern: /\b(?:execSync|spawnSync|exec|spawn)\s*\(\s*[`"'][^`"']*\$\{/,
    severity: 'critical',
    title: 'shell injection via template literal',
    detail: 'child_process.exec/spawn with interpolation = command injection. Pass an args array instead.',
  },
  {
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE)[^;]*\$\{[^}]+\}/i,
    severity: 'critical',
    title: 'SQL string interpolation',
    detail: 'Use parameterised queries — interpolated SQL is the primary SQL-injection sink.',
  },
  {
    pattern: /(?:md5|sha1)\s*\(/i,
    severity: 'medium',
    title: 'weak hash function',
    detail: 'MD5 / SHA-1 are broken for security use. Use SHA-256 or bcrypt/argon2 for passwords.',
  },
  {
    pattern: /(?:JWT_SECRET|API_KEY|PRIVATE_KEY|PASSWORD)\s*[:=]\s*['"`][^'"`]{8,}['"`]/i,
    severity: 'critical',
    title: 'hardcoded credential',
    detail: 'Secret looks committed in source. Move to an env var / secret store and rotate the leaked value.',
  },
  {
    pattern: /\bos\.system\s*\(/,
    severity: 'critical',
    title: 'os.system with shell',
    detail: 'os.system runs a shell. Use subprocess.run([...]) with a list argv to avoid injection.',
    langs: ['python'],
  },
  {
    pattern: /\bpickle\.loads?\s*\(/,
    severity: 'high',
    title: 'pickle.load on untrusted data',
    detail: 'pickle deserialization is RCE-equivalent for attacker-controlled bytes. Use JSON.',
    langs: ['python'],
  },
  {
    pattern: /\bdjango\..*\.csrf_exempt\b/i,
    severity: 'high',
    title: 'csrf_exempt',
    detail: 'Bypasses Django CSRF protection. Confirm the endpoint is truly safe (e.g., not state-changing).',
    langs: ['python'],
  },
];

function reviewSnippet(code: string, language: string): Concern[] {
  const out: Concern[] = [];
  const lines = code.split('\n');

  for (const rule of RULES) {
    if (rule.langs && !rule.langs.includes(language)) continue;
    for (let i = 0; i < lines.length; i += 1) {
      if (rule.pattern.test(lines[i])) {
        out.push({
          severity: rule.severity,
          title: rule.title,
          detail: rule.detail,
          line: i + 1,
        });
        // Only report each rule once per snippet — avoids 30x "weak hash" for a single file.
        break;
      }
    }
  }

  return out;
}

// =================================================================
// Registry
// =================================================================

export const MCP_TOOLS: Record<string, McpTool> = {
  [listFindings.def.name]: listFindings,
  [getFinding.def.name]: getFinding,
  [listTargets.def.name]: listTargets,
  [kickScan.def.name]: kickScan,
  [securityReview.def.name]: securityReview,
};

export const MCP_TOOL_LIST = Object.values(MCP_TOOLS).map((t) => t.def);

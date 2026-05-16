// Tier II #8 — MCP JSON-RPC 2.0 dispatcher.
//
// Implements the subset of the Model Context Protocol that Cursor +
// Claude Code + Anthropic's reference clients actually use today:
//
//   - initialize        protocol handshake
//   - notifications/initialized   (no-op ack)
//   - tools/list        tool catalog
//   - tools/call        dispatch to a tool's run()
//
// We do NOT implement:
//   - resources/*       (no resource model yet — tools-only v1)
//   - prompts/*         (same)
//   - completion/*      (rarely supported by clients in production)
//   - sampling/*        (server-asks-client; out of scope)
//
// Transport: Streamable HTTP — POST returns either a single JSON-RPC
// response or `text/event-stream` for streamed responses. Our v1
// returns single responses only (no streaming) because each tool's
// payload is small and round-trip-shaped.

import type { McpAuthContext } from './auth';
import { MCP_TOOL_LIST, MCP_TOOLS } from './tools';

// MCP version we support. Clients negotiate down if they're newer.
// 2024-11-05 is the version Anthropic + Cursor reference clients
// currently target.
const PROTOCOL_VERSION = '2024-11-05';

const SERVER_INFO = {
  name: 'tensorshield',
  version: '1.0.0',
};

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// JSON-RPC 2.0 standard error codes
//   -32700  Parse error
//   -32600  Invalid Request
//   -32601  Method not found
//   -32602  Invalid params
//   -32603  Internal error
const E_PARSE = -32700;
const E_INVALID_REQUEST = -32600;
const E_METHOD_NOT_FOUND = -32601;
const E_INVALID_PARAMS = -32602;
const E_INTERNAL = -32603;

export async function dispatchMcp(
  rawBody: string,
  ctx: McpAuthContext,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  let parsed: JsonRpcRequest | JsonRpcRequest[];
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return err(null, E_PARSE, 'parse error');
  }

  // JSON-RPC 2.0 batch shape — array of requests yields array of responses.
  if (Array.isArray(parsed)) {
    const results = await Promise.all(parsed.map((r) => dispatchOne(r, ctx)));
    const nonNull = results.filter((r): r is JsonRpcResponse => r !== null);
    return nonNull.length > 0 ? nonNull : null;
  }
  return dispatchOne(parsed, ctx);
}

async function dispatchOne(
  req: JsonRpcRequest,
  ctx: McpAuthContext,
): Promise<JsonRpcResponse | null> {
  // Notifications have no `id` — they return null (no response sent).
  const id = req.id ?? null;
  const isNotification = req.id === undefined || req.id === null;

  if (req.jsonrpc !== '2.0') {
    return isNotification ? null : err(id, E_INVALID_REQUEST, 'jsonrpc must be "2.0"');
  }
  if (typeof req.method !== 'string') {
    return isNotification ? null : err(id, E_INVALID_REQUEST, 'method must be a string');
  }

  try {
    switch (req.method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: {
              // listChanged: false — our tool list is static per-server-version.
              // Clients should not subscribe to change notifications.
              listChanged: false,
            },
          },
          serverInfo: SERVER_INFO,
          instructions:
            'TensorShield exposes 5 tools that give you read access to your org\'s ' +
            'security posture (findings, targets) plus the ability to kick a new ' +
            'scan and do a quick rule-based review of a code snippet. Use ' +
            'tensorshield_list_findings to start, tensorshield_get_finding to drill ' +
            'into details, and tensorshield_security_review while writing code.',
        });

      case 'notifications/initialized':
      case 'ping':
        // Notifications — no response by spec, but we return an empty
        // ok for `ping` (some clients expect a result).
        if (req.method === 'ping' && !isNotification) return ok(id, {});
        return null;

      case 'tools/list':
        return ok(id, {
          tools: MCP_TOOL_LIST.map((d) => ({
            name: d.name,
            description: d.description,
            inputSchema: d.inputSchema,
          })),
        });

      case 'tools/call': {
        const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        if (typeof params.name !== 'string') {
          return err(id, E_INVALID_PARAMS, '`name` (tool name) is required');
        }
        const tool = MCP_TOOLS[params.name];
        if (!tool) {
          return err(id, E_METHOD_NOT_FOUND, `unknown tool: ${params.name}`);
        }
        try {
          const result = await tool.run(params.arguments ?? {}, ctx);
          // MCP spec: tool errors come back inside the `result` object
          // with isError=true rather than as a JSON-RPC error. Clients
          // are expected to surface them to the model differently from
          // protocol errors (which usually abort the call entirely).
          return ok(id, result);
        } catch (e) {
          return ok(id, {
            content: [
              {
                type: 'text' as const,
                text: `tool crashed: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          });
        }
      }

      default:
        return isNotification ? null : err(id, E_METHOD_NOT_FOUND, `method not found: ${req.method}`);
    }
  } catch (e) {
    return err(id, E_INTERNAL, e instanceof Error ? e.message : 'internal error');
  }
}

function ok(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function err(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

import { NextResponse } from 'next/server';
import { authenticateMcpRequest } from '@/lib/mcp/auth';
import { dispatchMcp } from '@/lib/mcp/server';

// Tier II #8 — POST /api/mcp
//
// MCP Streamable HTTP transport endpoint. Cursor / Claude Code /
// any MCP-aware client config:
//
//   {
//     "mcpServers": {
//       "tensorshield": {
//         "url": "https://app.tensorshield.ai/api/mcp",
//         "headers": { "Authorization": "Bearer ts_xxxx..." }
//       }
//     }
//   }
//
// We return single JSON-RPC responses (no SSE streaming). The MCP
// spec allows both modes; tools-only servers without streaming
// payloads should default to single-response for predictable
// latency. If we later add a tool that produces incremental output
// (e.g., a live tail of a scan-in-progress), we'll opt that one
// tool into SSE.
//
// CORS: the typical MCP client is a desktop app (Cursor / Claude
// Code), not a browser, so no preflight handling. If we ever serve
// a browser-side MCP client, we'll need an OPTIONS handler too.

export const runtime = 'nodejs'; // crypto.randomBytes + crypto.createHash require node runtime

export async function POST(req: Request) {
  // ---- 1. Auth -----------------------------------------------------
  const ctx = await authenticateMcpRequest(req.headers);
  if (!ctx) {
    return jsonError(401, 'unauthenticated', -32000, 'invalid or missing API key');
  }

  // ---- 2. Read raw body --------------------------------------------
  // We read as text because JSON.parse is done inside dispatchMcp,
  // which also handles batch-vs-single shape.
  const rawBody = await req.text();
  if (!rawBody) {
    return jsonError(400, 'empty body', -32700, 'parse error');
  }

  // ---- 3. Dispatch -------------------------------------------------
  const out = await dispatchMcp(rawBody, ctx);

  // Notifications return null — no body, 202 Accepted by spec.
  if (out === null) {
    return new Response(null, { status: 202 });
  }

  return NextResponse.json(out);
}

// GET on /api/mcp returns server metadata + a hint about transport.
// Some clients prefetch this to confirm the endpoint is alive before
// initializing.
export async function GET() {
  return NextResponse.json({
    server: 'tensorshield',
    transport: 'streamable_http',
    methods: 'POST application/json — JSON-RPC 2.0 body',
    docs: '/settings/api-keys',
  });
}

// Compose a JSON-RPC-shaped error response wrapped in the right HTTP
// status. The HTTP code drives the client's retry behaviour; the
// JSON-RPC code drives how the LLM client surfaces the error.
function jsonError(
  httpStatus: number,
  httpMessage: string,
  jsonRpcCode: number,
  jsonRpcMessage: string,
): Response {
  return NextResponse.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: jsonRpcCode, message: jsonRpcMessage, data: { http: httpMessage } },
    },
    { status: httpStatus },
  );
}

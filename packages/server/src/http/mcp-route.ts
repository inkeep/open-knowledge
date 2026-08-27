/**
 * The `/mcp` Streamable HTTP leg, injected into the canonical Hono app so
 * `createHttpApp` stays a composition layer with no MCP semantics — the same
 * principle behind `NativeApiHandle`, though a different shape. Picking a
 * shape for a later surface: `NativeApiHandle` is for multi-path groups that
 * need a decline concept (its `dispatch` reports whether the table claimed
 * the URL); this leg is a bare fire-and-forget function because it has one
 * fixed path, no fallthrough of its own, and a response lifetime the MCP SDK
 * owns.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  HOST_NOT_ADMITTED_REMEDIATION,
  type IngressPolicy,
  isHostAdmitted,
  isOriginAdmitted,
  isPeerAdmitted,
} from '../ingress-policy.ts';
import type { PinoLogger } from '../logger.ts';
import type { McpHttpHandler } from '../mcp-http.ts';
import { errorResponse } from './error-response.ts';

const MCP_CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, traceparent, tracestate, baggage, mcp-session-id, mcp-protocol-version',
  // 24 h preflight cache — prevents a round-trip OPTIONS on every sequential tool call.
  'Access-Control-Max-Age': '86400',
};

/** The bound `/mcp` dispatch `createHttpApp` mounts behind its route claim. */
export type McpDispatch = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Bind the `/mcp` leg: unconditional peer + Host + Origin gates, the MCP
 * CORS headers, the OPTIONS preflight, and the raw `req`/`res` handoff to
 * the MCP SDK transport. `policy` MUST be the same object `createHttpApp`
 * receives as `ingressPolicy` — the surface prelude and these gates are two
 * layers of one admission decision, and a mount that rebuilds one of them
 * over a different policy would refuse externally-admitted `/mcp` calls
 * while `/api` serves them. A mount that diverges here turns the
 * tunnel-Host `/mcp` admission test in `remote-mcp.test.ts` red: the
 * exposed prelude admits the tunnel Host while a default-policy leg's own
 * Host gate refuses it. The handoff is fire-and-forget on purpose: a
 * session `GET` opens the transport's standalone SSE channel
 * (`Content-Type: text/event-stream`, held open for server-initiated
 * notifications — `enableJsonResponse` shapes POST responses only), so the
 * SDK owns the response lifetime and this dispatch must not await it or
 * buffer it through an adapter.
 */
export function createMcpDispatch(
  mcpHttpHandler: McpHttpHandler,
  policy: IngressPolicy,
  log: PinoLogger,
): McpDispatch {
  return (req, res) => {
    const origin = req.headers.origin;
    const sessionId = Array.isArray(req.headers['mcp-session-id'])
      ? req.headers['mcp-session-id'][0]
      : req.headers['mcp-session-id'];
    // The policy's peer + Host gate pair.
    if (!isPeerAdmitted(req.socket.remoteAddress, policy)) {
      errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
        handler: 'mcp',
      });
      return;
    }
    if (!isHostAdmitted(req.headers.host, policy)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'mcp',
        detail: HOST_NOT_ADMITTED_REMEDIATION,
      });
      return;
    }
    if (origin !== undefined && !isOriginAdmitted(origin, policy)) {
      errorResponse(res, 403, 'urn:ok:error:invalid-origin', 'Origin not allowed.', {
        handler: 'mcp',
      });
      return;
    }
    if (origin !== undefined) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    for (const [header, value] of Object.entries(MCP_CORS_HEADERS)) {
      res.setHeader(header, value);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    mcpHttpHandler.handle(req, res).catch((err) => {
      log.error({ err, sessionId }, 'Unhandled MCP HTTP error');
      if (!res.writableEnded && !res.headersSent) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'mcp',
          cause: err,
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  };
}

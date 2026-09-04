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
  'Access-Control-Max-Age': '86400',
};

export type McpDispatch = (req: IncomingMessage, res: ServerResponse) => void;

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

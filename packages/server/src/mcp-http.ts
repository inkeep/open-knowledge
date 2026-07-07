import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { displayNameFromClientName } from '@inkeep/open-knowledge-core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { validateAgentId } from './agent-id.ts';
import type { Config } from './config/schema.ts';
import { MCP_SERVER_NAME } from './constants.ts';
import {
  type AgentIdentity,
  MCP_CONNECTION_ID_HEADER,
  sanitizeClientName,
} from './mcp/agent-identity.ts';
import { installPrettyZodErrors } from './mcp/pretty-zod-errors.ts';
import { registerAllTools } from './mcp/tools/index.ts';
import { resolveWithinRoot } from './mcp/tools/path-safety.ts';
import { RUNTIME_VERSION } from './version-constants.ts';

interface McpHttpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  ttlTimer?: ReturnType<typeof setTimeout>;
}

export interface McpHttpHandlerOptions {
  contentDir: string;
  projectDir?: string;
  /**
   * The project's loaded `Config`. Tool handlers read settings off this object
   * (e.g. `config.content.dir`). The fields used downstream MUST match what
   * the user wrote in `.ok/config.yml` — never fabricate a synthetic config
   * here.
   */
  config: Config;
  /** Returns the base URL of this running HTTP server, without the `/mcp` suffix. */
  getServerUrl: () => string;
  log?: {
    info?: (obj: object, msg: string) => void;
    warn?: (obj: object, msg: string) => void;
    error?: (obj: object, msg: string) => void;
  };
  sessionTtlMs?: number;
  maxSessions?: number;
}

export interface McpHttpHandler {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  close: () => Promise<void>;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function writePlain(res: ServerResponse, statusCode: number, message: string): void {
  if (res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message);
}

function createSessionServer(
  opts: McpHttpHandlerOptions,
  transport: StreamableHTTPServerTransport,
  forwardedConnectionId: string | undefined,
): McpHttpSession {
  const config = opts.config;
  // No `instructions` handshake — see startGlobalMcpServer. The
  // project skill is the single steering channel; the HTTP server only ever
  // runs inside an OK project, where that skill is installed.
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: RUNTIME_VERSION,
  });
  installPrettyZodErrors(server);

  // `connectionId` is the only stable per-session disambiguator when multiple
  // clients report the same MCP `clientInfo.name`, such as two Claude
  // instances connected to the same `ok start` server.
  //
  // When the `ok mcp` shim forwards its keepalive WS connectionId via the
  // `MCP_CONNECTION_ID_HEADER`, adopt it so the keepalive's 3 s
  // `bumpPresenceTs` heartbeat and on-close `clearPresence` (both keyed by
  // the keepalive id) operate on the same broadcaster entry that write
  // handlers create with `agentId: identity.connectionId`. Without this
  // unification the icon flickers per tool call (5 s TTL) instead of
  // staying visible for the lifetime of the MCP session.
  const connectionId = forwardedConnectionId ?? randomUUID();
  const identityRef: { current: AgentIdentity } = {
    current: {
      connectionId,
      displayName: connectionId,
      colorSeed: connectionId,
    },
  };

  server.server.oninitialized = () => {
    const clientInfo = server.server.getClientVersion();
    const name = sanitizeClientName(clientInfo?.name, connectionId);
    identityRef.current = {
      connectionId,
      clientInfo: clientInfo ? { name, version: clientInfo.version } : undefined,
      displayName: displayNameFromClientName(name),
      colorSeed: name,
    };
  };

  // The configured project root is the trust boundary for every tool call:
  // an explicit `cwd` arg from the MCP client must lexically resolve to,
  // or under, this directory. Without this gate the tools accept any
  // absolute path the caller hands them (`cwd: "/etc"`) and exec /
  // search reach outside the configured content scope —
  // see resolveWithinRoot() for the containment contract. The MCP-roots
  // negotiation (one-advertised-root → default) lives in the stdio
  // proxy; the HTTP MCP server here always anchors on the configured
  // projectDir / contentDir.
  const configuredRoot = opts.projectDir ?? opts.contentDir;
  registerAllTools(server, {
    serverUrl: async () => opts.getServerUrl(),
    resolveCwd: async (explicit?: string) => {
      if (explicit === undefined) return configuredRoot;
      const result = resolveWithinRoot(configuredRoot, explicit);
      if (!result.ok) {
        throw new Error(
          `cwd "${explicit}" is not within the configured project root: ${result.reason}`,
        );
      }
      return result.abs;
    },
    config,
    identityRef,
  });

  return { server, transport };
}

/**
 * Create a stateful Streamable HTTP MCP endpoint handler for `POST/GET/DELETE /mcp`.
 *
 * The MCP implementation lives in the running project server. A stdio `ok mcp`
 * process should only proxy JSON-RPC frames to this endpoint; it should not
 * register tools itself.
 */
export function createMcpHttpHandler(opts: McpHttpHandlerOptions): McpHttpHandler {
  const sessions = new Map<string, McpHttpSession>();
  const sessionTtlMs = opts.sessionTtlMs ?? 30 * 60 * 1000;
  const maxSessions = opts.maxSessions ?? 100;

  async function closeSession(sessionId: string, reason: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    if (session.ttlTimer !== undefined) clearTimeout(session.ttlTimer);
    const results = await Promise.allSettled([session.server.close(), session.transport.close()]);
    for (const result of results) {
      if (result.status === 'rejected') {
        opts.log?.warn?.(
          { err: result.reason, sessionId, reason },
          'MCP HTTP session close failed',
        );
      }
    }
    opts.log?.info?.({ sessionId, reason }, 'MCP HTTP session closed');
  }

  function touchSession(sessionId: string, session: McpHttpSession): void {
    if (session.ttlTimer !== undefined) clearTimeout(session.ttlTimer);
    session.ttlTimer = setTimeout(() => {
      void closeSession(sessionId, 'ttl-expired').catch((err) => {
        opts.log?.warn?.({ err, sessionId }, 'MCP HTTP session TTL cleanup failed');
      });
    }, sessionTtlMs);
    session.ttlTimer.unref?.();
  }

  return {
    async handle(req, res): Promise<void> {
      const sessionId = firstHeader(req.headers['mcp-session-id']);
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          writePlain(res, 404, 'MCP session not found');
          return;
        }
        touchSession(sessionId, session);
        await session.transport.handleRequest(req, res);
        return;
      }

      if (req.method !== 'POST') {
        writePlain(res, 400, 'Missing MCP session. Initialize with POST /mcp first.');
        return;
      }
      if (sessions.size >= maxSessions) {
        opts.log?.warn?.(
          { activeSessions: sessions.size, maxSessions },
          'MCP HTTP session cap reached',
        );
        writePlain(res, 503, 'Too many active MCP sessions');
        return;
      }

      // Captured before `transport.handleRequest` consumes the request so
      // `onsessioninitialized` (which fires after body parse) can use it.
      // Validation goes through the same checks the keepalive WS path uses
      // (`validateAgentId`); a header that fails validation falls back to
      // randomUUID rather than rejecting the session, so a non-shim client
      // that happens to send an invalid value still gets a working MCP
      // session — it just doesn't get presence-icon stickiness.
      const rawConnectionIdHeader = firstHeader(req.headers[MCP_CONNECTION_ID_HEADER]);
      const forwardedConnectionId = validateAgentId(rawConnectionIdHeader) ?? undefined;
      if (rawConnectionIdHeader !== undefined && forwardedConnectionId === undefined) {
        // Header value is unbounded-cardinality and possibly attacker-controlled;
        // log the length only so operators can correlate without leaking bytes.
        opts.log?.warn?.(
          { headerLength: rawConnectionIdHeader.length },
          'MCP HTTP forwarded connectionId header failed validation; falling back to randomUUID',
        );
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: async (newSessionId) => {
          try {
            const session = createSessionServer(opts, transport, forwardedConnectionId);
            await session.server.connect(transport);
            sessions.set(newSessionId, session);
            touchSession(newSessionId, session);
            opts.log?.info?.({ sessionId: newSessionId }, 'MCP HTTP session initialized');
          } catch (err) {
            sessions.delete(newSessionId);
            opts.log?.error?.(
              { err, sessionId: newSessionId },
              'MCP HTTP session initialization failed',
            );
            throw err;
          }
        },
      });

      transport.onerror = (err) => {
        opts.log?.warn?.({ err }, 'MCP HTTP transport error');
      };
      transport.onclose = () => {
        const id = transport.sessionId;
        if (!id) {
          opts.log?.info?.(
            { sessionId: id, reason: 'transport-closed' },
            'MCP HTTP session closed',
          );
          return;
        }
        void closeSession(id, 'transport-closed').catch((err) => {
          opts.log?.warn?.({ err, sessionId: id }, 'MCP HTTP transport-close cleanup failed');
        });
      };

      await transport.handleRequest(req, res);
    },

    async close(): Promise<void> {
      const active = [...sessions.entries()];
      await Promise.allSettled(
        active.map(([sessionId]) => closeSession(sessionId, 'handler-close')),
      );
    },
  };
}

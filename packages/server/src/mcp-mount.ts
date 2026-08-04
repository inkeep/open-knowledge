/**
 * `mountMcpAndApi` is the canonical HTTP adapter for `/mcp`, `/api/*`, content
 * assets, and the optional React shell. `bootServer()` and the integration
 * harnesses use it; Vite owns its Connect middleware and shares only the
 * collaboration host.
 *
 * Collaboration WebSocket routing and lifecycle live in
 * `createCollaborationHost()`. This adapter delegates `/collab`,
 * `/collab/keepalive`, and `/collab/thread` upgrades to that host, then owns
 * only the fallback that rejects unknown upgrade paths.
 *
 * The adapter attaches both `'request'` and `'upgrade'` listeners to the
 * supplied `httpServer`. Callers therefore MUST `createHttpServer()` with no
 * constructor callback — passing a `(req, res) => {…}` arg would install a
 * second `'request'` listener and double-handle every inbound HTTP request.
 *
 * `shutdown()` leaves request routing attached until the caller closes the HTTP
 * server so requests do not silently hang during later teardown phases. It
 * detaches upgrades before draining the collaboration host so no new WebSocket
 * can escape that one-shot drain.
 */

import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Hocuspocus } from '@hocuspocus/server';
import type { WebSocketServer } from 'ws';
import type { AcpThreadManager } from './acp/thread-manager.ts';
import type { AgentFocusBroadcaster } from './agent-focus.ts';
import type { AgentPresenceBroadcaster } from './agent-presence.ts';
import type { AgentSessionManager } from './agent-sessions.ts';
import { isAllowedApiOrigin } from './api-origin.ts';
import { createCollaborationHost } from './collaboration-host.ts';
import { errorResponse } from './http/error-response.ts';
import { createHttpApp, type HealthProvider } from './http/http-app.ts';
import type { PinoLogger } from './logger.ts';
import { isAllowedWorkspaceHostHeader, isLoopbackAddress } from './loopback.ts';
import type { MaintenanceCoordinator } from './maintenance-coordinator.ts';
import type { McpHttpHandler } from './mcp-http.ts';
import {
  hasForwardingHeaders,
  isRemoteAdmitted,
  type ResolvedRemoteAccess,
} from './remote-access.ts';

export type { ReadinessState } from './http/http-app.ts';

const MCP_CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, traceparent, tracestate, baggage, mcp-session-id, mcp-protocol-version',
  // 24 h preflight cache — prevents a round-trip OPTIONS on every sequential tool call.
  'Access-Control-Max-Age': '86400',
};

export interface MountMcpAndApiOptions {
  /** HTTP server constructed with no constructor callback (the helper installs `'request'` + `'upgrade'` listeners). */
  httpServer: HttpServer;
  /** Hocuspocus instance whose `onRequest` extensions answer `/api/*` and whose `handleConnection` answers `/collab`. */
  hocuspocus: Hocuspocus;
  /**
   * MCP Streamable HTTP handler. When omitted, `/mcp` is NOT mounted — the
   * `createRestartableServer` test helper takes this path because its
   * fast-restart contract has no MCP component.
   */
  mcpHttpHandler?: McpHttpHandler;
  /** Logger for upgrade / request errors. */
  log: PinoLogger;
  /**
   * Agent session manager. Used inside the `/collab/keepalive` grace-timer
   * callback to evict the connection's sessions on disconnect. Optional —
   * `createRestartableServer` does not wire keepalive cleanup because the
   * killNetwork path tears down the underlying `srv` directly.
   */
  sessionManager?: AgentSessionManager;
  /** Agent focus broadcaster. Cleared per-`connectionId` on grace expiry. */
  agentFocusBroadcaster?: AgentFocusBroadcaster | null;
  /**
   * Agent presence broadcaster. Used both for the 3 s `bumpPresenceTs` heartbeat
   * (under the keyed `agent-<id>` map key via `toBroadcasterKey`) and for
   * `clearPresence` on grace expiry.
   */
  agentPresenceBroadcaster?: AgentPresenceBroadcaster | null;
  /**
   * Shadow-repo maintenance coordinator. On keepalive-grace expiry a
   * closed agent session may have left a dead WIP chain behind, so we evaluate
   * maintenance off the write path. Undefined in plugin/ephemeral modes.
   */
  maintenanceCoordinator?: MaintenanceCoordinator;
  /**
   * Grace period (ms) before keepalive-close triggers session cleanup. Default 10 000.
   * Tests pass smaller values (e.g. 100–150) for fast teardown.
   */
  keepaliveGraceMs?: number;
  /**
   * Optional content-asset middleware (the `createAssetServeMiddleware` result).
   * When supplied, it runs for non-`/mcp`, non-`/api/*` requests *before* the
   * catch-all 404. Its own content-filter exclusion / sirv fall-through calls
   * `next()`, which lands on the same 404 as today. Used by `bootServer` in
   * desktop mode so the utility server's `apiOrigin` serves content assets
   * (the Electron renderer page origin has no asset middleware). The CLI / test
   * harness leave it undefined.
   */
  contentAssetMiddleware?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  /**
   * Optional React-shell middleware (a configured `sirv` over the bundled
   * React app's `dist/` directory). When supplied, it runs as the final
   * fallback for non-`/mcp`, non-`/api/*` requests — AFTER
   * `contentAssetMiddleware` (so user-uploaded content takes priority and
   * the SPA shell only handles routes the content middleware didn't claim).
   * Used by OK Electron's utility process so external agent in-app browsers
   * can render the bundled React app from the same HTTP port the API runs
   * on. The CLI / test harness leave it undefined — `ok ui` already serves
   * the shell on its own port.
   */
  reactShellMiddleware?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  /**
   * ACP thread host answering the `/collab/thread` upgrade. When omitted or
   * null (ephemeral mode, restartable test harness), the branch fail-closes
   * by destroying the socket — no thread surface exists to reach.
   */
  acpThreadManager?: AcpThreadManager | null;
  /**
   * No-project ephemeral single-file mode (`ok <file>`). When `true`, the
   * content-asset surface is gated by the same loopback + workspace-host
   * checks the `/mcp` + `/collab/keepalive` legs use. In ephemeral mode
   * `contentDir` is the opened file's parent — often a user-data dir
   * (`~/Downloads`, `~/Documents`) the user never consciously chose to serve —
   * so an ungated asset endpoint would let any localhost-reaching caller,
   * including a DNS-rebound malicious page, read those files. Project / desktop
   * modes leave this `false` (the user chose the served root) so their asset
   * serving is unchanged.
   */
  ephemeral?: boolean;
  /**
   * Readiness provider for `/readyz`. `readiness()` reports the async-init
   * lifecycle; `degraded()` lists subsystems that failed to initialize (the
   * `BootedServer.degraded` list — stable only once readiness is `ready`).
   * When omitted (restartable test harness, whose init is synchronous), the
   * health routes still mount and report ready with no degraded subsystems.
   */
  health?: HealthProvider;
  /**
   * Resolved `remote:` config (null/undefined ⇒ remote access disabled).
   * When set, EVERY surface (`/mcp`, `/api/*`, `/collab`, content assets,
   * the SPA) admits requests whose Host is either a loopback name or the
   * tunnel's public host — the trust-the-tunnel model: OK does not
   * authenticate remote callers, the tunnel's edge does (see
   * `remote-access.ts`). Wrong-Host requests (DNS-rebound pages) are refused.
   * Local loopback behavior is byte-for-byte unchanged.
   *
   * When null/undefined, requests carrying proxy-forwarding headers are
   * refused with a hint — a tunnel pointed at a server that never opted in
   * must fail loud, not silently inherit full local trust.
   */
  remoteAccess?: ResolvedRemoteAccess | null;
}

export interface MountMcpAndApiHandle {
  /**
   * The shared `WebSocketServer({ noServer: true })`. Caller is responsible
   * for `wss.close()` AFTER `shutdown()` resolves — once destroy of the
   * underlying server has flushed any in-flight observer work.
   */
  wss: WebSocketServer;
  /**
   * Destroy every live upgrade socket, then cancel pending keepalive grace
   * timers and await any in-flight cleanup promises so the caller's destroy
   * path does not race a still-firing callback into a torn-down
   * `sessionManager` / broadcaster. Idempotent.
   *
   * Draining the sockets is what lets the caller's later `wss.close()` and
   * `httpServer.close()` steps resolve promptly: an upgraded WS socket is
   * detached from the HTTP server, and `httpServer.close()` will not return
   * while one is still open. `httpServer.closeAllConnections()` is the intended
   * backstop but does not reliably reap upgrade-detached sockets across
   * runtimes (notably the packaged Electron/Node build), so without this drain
   * a single live `/collab` or `/collab/keepalive` client stalls both close
   * steps for the full destroy-step timeout each. Mirrors the upgrade-socket
   * drain in `cli/src/commands/ui.ts` / `ui-proxy.ts`.
   */
  shutdown: () => Promise<void>;
}

/**
 * Wire `/mcp` + `/api/*` + the `/collab` + `/collab/keepalive` WS upgrade onto
 * the supplied `httpServer`. See module doc-block for the full contract.
 */
export function mountMcpAndApi(opts: MountMcpAndApiOptions): MountMcpAndApiHandle {
  const {
    httpServer,
    hocuspocus,
    mcpHttpHandler,
    log,
    sessionManager,
    agentFocusBroadcaster,
    agentPresenceBroadcaster,
    maintenanceCoordinator,
    contentAssetMiddleware,
    reactShellMiddleware,
    ephemeral,
  } = opts;
  const remoteAccess = opts.remoteAccess ?? undefined;

  const collaborationHost = createCollaborationHost({
    hocuspocus,
    log,
    sessionManager,
    agentFocusBroadcaster,
    agentPresenceBroadcaster,
    maintenanceCoordinator,
    keepaliveGraceMs: opts.keepaliveGraceMs,
    acpThreadManager: opts.acpThreadManager,
    remoteAccess,
  });

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url?.split('?')[0];
    // Tripwire: proxy-forwarding headers on a server that never opted into
    // remote access mean a tunnel is pointed at us. Refuse with the fix
    // instruction — the alternative is silently serving a public tunnel with
    // full local trust, decided by whether the tunnel rewrites Host.
    if (remoteAccess === undefined && hasForwardingHeaders(req)) {
      errorResponse(
        res,
        403,
        'urn:ok:error:host-not-allowed',
        'Proxied request refused: this server was not started for remote access. Restart with `ok start --remote` to serve through a tunnel.',
        { handler: 'mcp-mount' },
      );
      return;
    }
    // With remote access enabled, ONE admit decision covers every surface
    // (trust-the-tunnel — see remote-access.ts): loopback socket + Host on
    // the allowlist (loopback names or the tunnel's public host). Refusals
    // are wrong-Host callers (DNS-rebound pages), not auth failures.
    if (remoteAccess !== undefined && !isRemoteAdmitted(req, remoteAccess)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'mcp-mount',
      });
      return;
    }
    if (mcpHttpHandler !== undefined && url === '/mcp') {
      const origin = req.headers.origin;
      const sessionId = Array.isArray(req.headers['mcp-session-id'])
        ? req.headers['mcp-session-id'][0]
        : req.headers['mcp-session-id'];
      if (remoteAccess === undefined) {
        // The pre-remote gate pair, unchanged: loopback socket + loopback
        // Host. (With remote enabled the shared admit gate above already
        // enforced the superset.)
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback access required.', {
            handler: 'mcp',
          });
          return;
        }
        if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
          errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
            handler: 'mcp',
          });
          return;
        }
      }
      if (origin !== undefined && !isAllowedApiOrigin(origin, remoteAccess?.publicHost)) {
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
      return;
    }
    if (url?.startsWith('/api/')) {
      hocuspocus
        // biome-ignore lint/suspicious/noExplicitAny: Hocuspocus `hooks()` has no exported payload type for onRequest
        .hooks('onRequest', { request: req, response: res } as any)
        .then(() => {
          // RFC 9457 problem+json fallback for unmatched /api/* routes.
          // Defense-in-depth: api-extension.ts has its own dispatch-level 404,
          // so this branch is unreachable in normal flow. Keep it as a backstop
          // for cases where a Hocuspocus extension intercepts the request before
          // api-extension.ts runs.
          if (res.writableEnded || res.headersSent) return;
          errorResponse(res, 404, 'urn:ok:error:not-found', 'API endpoint not found.', {
            handler: 'mcp-mount',
            detail: `No handler for ${req.method ?? 'GET'} ${url}`,
          });
        })
        .catch((err) => {
          log.error({ err }, 'Unhandled onRequest error');
          if (!res.writableEnded && !res.headersSent) {
            errorResponse(
              res,
              500,
              'urn:ok:error:internal-server-error',
              'Internal server error.',
              { handler: 'mcp-mount', cause: err },
            );
          } else if (!res.writableEnded) {
            res.end();
          }
        });
      return;
    }
    // Static serving for non-`/mcp`, non-`/api/*` requests. Two middlewares
    // may be wired (desktop mode): `contentAssetMiddleware` over the content
    // dir and `reactShellMiddleware` (sirv) over the bundled SPA `dist/`.
    // Never sees `/mcp` or `/api/*` (handled above), so no shadowing risk.
    //
    // Both runners wrap their middleware in try/catch: sirv reaches the
    // filesystem synchronously (`fs.existsSync` / `fs.statSync` in `viaLocal`),
    // so under FD exhaustion (`EMFILE`/`ENFILE`) or transient FS errors those
    // calls throw — without the catch the throw propagates to `http.Server`'s
    // 'request' listener and the response hangs until `requestTimeout`. Mirrors
    // the `.catch()` posture on the `/mcp` and `/api/*` legs.
    const runMiddleware = (
      middleware:
        | ((req: IncomingMessage, res: ServerResponse, next: () => void) => void)
        | undefined,
      label: string,
      onMiss: () => void,
    ): void => {
      if (middleware === undefined) {
        onMiss();
        return;
      }
      try {
        middleware(req, res, () => {
          if (res.writableEnded || res.headersSent) return;
          onMiss();
        });
      } catch (err) {
        log.error({ err }, `Unhandled ${label} middleware error`);
        if (!res.writableEnded && !res.headersSent) {
          errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
            handler: 'mcp-mount',
            cause: err,
          });
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    };
    const runContent = (onMiss: () => void): void => {
      // Ephemeral single-file mode serves assets out of the opened file's
      // parent dir; mirror the `/mcp` loopback + workspace-host gate so a
      // DNS-rebound or non-loopback caller can't read that user-data dir.
      // Origin is intentionally NOT checked: no-cors `<img>` / CSS asset loads
      // omit it, and the Host-header check already rejects the rebinding
      // content-exfil vector without that dependency. Project / desktop modes
      // (`ephemeral` falsy) are unchanged — the user chose the served root.
      if (
        ephemeral === true &&
        contentAssetMiddleware !== undefined &&
        (!isLoopbackAddress(req.socket.remoteAddress) ||
          !isAllowedWorkspaceHostHeader(req.headers.host))
      ) {
        errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback access required.', {
          handler: 'content-asset',
        });
        return;
      }
      runMiddleware(contentAssetMiddleware, 'content-asset', onMiss);
    };
    const runShell = (onMiss: () => void): void =>
      runMiddleware(reactShellMiddleware, 'react-shell', onMiss);
    const notFound = (): void => {
      if (res.writableEnded || res.headersSent) return;
      // When this server doesn't serve the React shell (CLI / MCP-spawned —
      // content assets mount by default but the UI lives on the `ok ui`
      // sibling), keep the operator hint so a human loading `/` in a browser
      // is pointed at the right port.
      const uiHint =
        reactShellMiddleware === undefined
          ? 'The React UI is served by `ok ui` (run `ok ui` and check `ui.lock.port`). '
          : '';
      errorResponse(res, 404, 'urn:ok:error:not-found', 'Not found.', {
        handler: 'mcp-mount',
        detail: `${uiHint}No handler for ${url ?? '/'}`,
      });
    };

    // SPA-bundle assets (Vite's `build.assetsDir`) live under `/assets/` with
    // hashed names — fonts (`.woff2`/`.ttf`/`.otf`), bundled images, sprite
    // sheets. The content middleware fail-closes (404 WITHOUT `next()`) on a
    // known asset extension when the content dir misses, so content-first would
    // 404 every SPA-bundled woff2/png/svg whose name isn't ALSO present under
    // `<contentDir>/assets/` — `js`/`css` aren't asset extensions so they
    // already fall through, which is why only fonts/images regressed. Try the
    // shell first for this prefix; fall through to the content middleware on a
    // miss so user uploads at `<contentDir>/assets/*` still serve. Mirrors
    // `ok ui`'s `/assets/`-first branch in `commands/ui.ts`.
    if (reactShellMiddleware !== undefined && url?.startsWith('/assets/')) {
      runShell(() => runContent(notFound));
      return;
    }
    // Everything else (non-`/assets/`): content (user uploads / doc-referenced
    // media) takes priority; the SPA shell is the fallback (its `single: true`
    // serves `index.html` for unknown extension-less deep-links). The
    // content-first invariant holds only here — `/assets/*` is shell-first
    // (handled above).
    if (contentAssetMiddleware !== undefined || reactShellMiddleware !== undefined) {
      runContent(() => runShell(notFound));
      return;
    }
    // Neither middleware wired (CLI / test harness) — catch-all 404. Static
    // React assets are served by `ok ui` (a CLI wrapper concern, not modeled
    // here); every other path lands here.
    errorResponse(res, 404, 'urn:ok:error:not-found', 'Not found.', {
      handler: 'mcp-mount',
      detail: `The React UI is served by \`ok ui\` (run \`ok ui\` and check \`ui.lock.port\`). No handler for ${url ?? '/'}`,
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (collaborationHost.handleUpgrade(req, socket, head)) return;
    if (remoteAccess === undefined && hasForwardingHeaders(req)) {
      log.warn(
        { url: req.url, host: req.headers.host },
        '[remote] refused proxied WS upgrade; start the server with `ok start --remote <url>`',
      );
    }
    socket.destroy();
  };

  // The canonical Hono app owns top-level routing (health natively; every
  // unmigrated surface falls through its catch-all into `onRequest`
  // unchanged). The WS upgrade path stays a raw listener — it never routes
  // through HTTP dispatch.
  const { requestListener } = createHttpApp({
    health: opts.health,
    legacyDispatch: onRequest,
    log,
  });
  httpServer.on('request', requestListener);
  httpServer.on('upgrade', onUpgrade);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      // Reject new upgrades before the host's one-shot socket drain; a socket
      // admitted afterward would have no later mount shutdown to reap it.
      httpServer.off('upgrade', onUpgrade);
      await collaborationHost.shutdown();
    })();
    return shutdownPromise;
  };

  return {
    wss: collaborationHost.wss,
    shutdown,
  };
}

/**
 * Extract + validate the `connectionId` query param from a `/collab/keepalive`
 * upgrade URL. Tolerant of: missing URL (`undefined`), unparseable URL,
 * missing/empty `connectionId`. Values that do not match `AGENT_ID_RE`
 * (`[a-zA-Z0-9_-]+`) return `null` — the close handler then falls through
 * to TTL-only cleanup rather than firing `clearPresence` /
 * `closeAllForAgent` / `clearFocus` with attacker-controlled bytes.
 *
 * The validation is intentionally identical to the HTTP write path
 * (`extractAgentIdentity` in `api-extension.ts`) so the write surface and
 * the cleanup surface share one contract. Without it, a caller who can
 * reach the keepalive WS (e.g. an unauthenticated peer when the user has
 * bound to `0.0.0.0`) could force-evict another agent's presence entry
 * by passing a crafted `connectionId=<victim>` on WS close. The shared
 * regex also prevents CR/LF bytes in query-string values from reaching
 * the structured `[keepalive] disconnected` log line (log-injection
 * defense-in-depth — pino escapes these but some transports strip the
 * escaping after egress).
 *
 * Exported for unit testing. Never throws.
 */
export { parseKeepaliveConnectionId, parseKeepaliveIdentity } from './collaboration-host.ts';

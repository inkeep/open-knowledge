/**
 * `mountMcpAndApi` — single canonical wiring for `/mcp` + `/api/*` + WS upgrade.
 *
 * Three consumers compose the same four ingredients on top of an `http.Server`:
 *   1. `bootServer()` (CLI `ok start`, Electron utility, Vite dev plugin via the
 *      shared boot path).
 *   2. The integration test harness's `createTestServer()`.
 *   3. The integration test harness's `createRestartableServer()` (no `/mcp` —
 *      passes `mcpHttpHandler: undefined`).
 *
 * Before this extraction every consumer reimplemented the request handler, the
 * `WebSocketServer({ noServer: true })`, the `/collab/keepalive` short-circuit,
 * the keepalive-grace timer map, and the per-`connectionId` cleanup cascade
 * (`closeAllForAgent` + `clearFocus` + `clearPresence`). The duplication had
 * already drifted: `boot.ts` validated `connectionId` via `validateAgentId` to
 * defend against log-injection / `clearPresence` cross-eviction; the harness
 * accepted any `connectionId` query param. Centralizing in one helper closes
 * that drift class permanently — every consumer gets the production-grade
 * validation path.
 *
 * The helper attaches both `'request'` and `'upgrade'` listeners to the
 * supplied `httpServer`. Callers therefore MUST `createHttpServer()` with no
 * constructor callback — passing a `(req, res) => {…}` arg would install a
 * second `'request'` listener and double-handle every inbound HTTP request.
 *
 * `shutdown()` cancels pending grace timers + awaits in-flight cleanups so
 * caller `destroy()` paths do not race a still-firing grace callback into
 * a torn-down `sessionManager` / broadcaster.
 */

import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Hocuspocus } from '@hocuspocus/server';
import { AGENT_ICON_COLORS, colorFromSeed, iconFromClientName } from '@inkeep/open-knowledge-core';
import { WebSocketServer } from 'ws';
import type { AgentFocusBroadcaster } from './agent-focus.ts';
import { toBroadcasterKey, validateAgentId } from './agent-id.ts';
import type { AgentPresenceBroadcaster } from './agent-presence.ts';
import type { AgentSessionManager } from './agent-sessions.ts';
import { isAllowedApiOrigin } from './api-origin.ts';
import { errorResponse } from './http/error-response.ts';
import type { PinoLogger } from './logger.ts';
import { isAllowedWorkspaceHostHeader, isLoopbackAddress } from './loopback.ts';
import type { MaintenanceCoordinator } from './maintenance-coordinator.ts';
import type { McpHttpHandler } from './mcp-http.ts';
import { handleCollabSocketError, incrementCollabMessageTooLarge } from './metrics.ts';

const DEFAULT_KEEPALIVE_GRACE_MS = 10_000;
const MAX_COLLAB_MESSAGE_BYTES = 1024 * 1024;
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
  const keepaliveGraceMs = opts.keepaliveGraceMs ?? DEFAULT_KEEPALIVE_GRACE_MS;

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_COLLAB_MESSAGE_BYTES });
  wss.on('error', (err) => {
    log.error({ err }, 'WebSocketServer error');
  });

  // connectionId → pending grace timer handle.
  const keepaliveGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // In-flight grace-timer callbacks so `shutdown()` can await them rather than
  // racing against the sessionManager / agentFocusBroadcaster teardown.
  const keepaliveGraceInflight = new Set<Promise<void>>();
  // Raw upgrade sockets (the `Duplex` handed to the `'upgrade'` handler) for
  // every live `/collab` + `/collab/keepalive` connection. `shutdown()` destroys
  // these so the caller's `wss.close()` / `httpServer.close()` steps resolve —
  // an upgraded socket is detached from the HTTP server and `httpServer.close()`
  // will not return while one is open, and `httpServer.closeAllConnections()`
  // does not reliably reap upgrade-detached sockets across runtimes. Mirrors
  // the drain in `cli/src/commands/ui.ts` / `ui-proxy.ts`.
  const liveUpgradeSockets = new Set<Duplex>();
  // Set when `shutdown()` runs so any callback that fired just before the
  // timer was cleared can short-circuit instead of touching disposed resources.
  let shuttingDown = false;

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url?.split('?')[0];
    if (mcpHttpHandler !== undefined && url === '/mcp') {
      const origin = req.headers.origin;
      const sessionId = Array.isArray(req.headers['mcp-session-id'])
        ? req.headers['mcp-session-id'][0]
        : req.headers['mcp-session-id'];
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
      if (origin !== undefined && !isAllowedApiOrigin(origin)) {
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
      errorResponse(res, 404, 'urn:ok:error:not-found', 'Not found.', {
        handler: 'mcp-mount',
        detail: `No handler for ${url ?? '/'}`,
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
    if (req.url?.startsWith('/collab/keepalive')) {
      if (
        !isLoopbackAddress(req.socket.remoteAddress) ||
        !isAllowedWorkspaceHostHeader(req.headers.host)
      ) {
        socket.destroy();
        return;
      }
      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (handleCollabSocketError(err)) return;
        log.error({ err }, 'MCP keepalive socket error');
      });
      liveUpgradeSockets.add(socket);
      socket.once('close', () => liveUpgradeSockets.delete(socket));
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Per-session connectionId from the URL. Validated through the same
        // regex as the HTTP write path (`extractAgentIdentity` in
        // `api-extension.ts`) so the keepalive cleanup surface and the write
        // surface share one contract — without it a caller who can reach the
        // keepalive WS could force-evict another agent's presence by
        // crafting `connectionId=<victim>` on close.
        const connectionId = parseKeepaliveConnectionId(req.url);

        // Reconnect within the grace window cancels the pending eviction.
        if (connectionId) {
          const existing = keepaliveGraceTimers.get(connectionId);
          if (existing !== undefined) {
            clearTimeout(existing);
            keepaliveGraceTimers.delete(connectionId);
            log.info({ connectionId }, '[keepalive] reconnect during grace — timer cancelled');
          }
        }

        // Bootstrap a presence entry on connect when the cli's MCP shim
        // forwarded full identity in the URL. Without this, `bumpPresenceTs`
        // (the 3 s heartbeat below) is a documented no-op until something
        // else calls `setPresence` first — which only happens for the four
        // mutating HTTP write handlers in `api-extension.ts`. Lifting the
        // bootstrap to the WS-upgrade handler makes presence appear on
        // every MCP connect, regardless of whether the agent ever issues
        // a write tool.
        //
        // Identity sanitisation lives in `parseKeepaliveIdentity` — log
        // injection / awareness pollution surface. Mirrors the helper-chain
        // the four handler-level setPresence sites use (iconFromClientName /
        // AGENT_ICON_COLORS / colorFromSeed) so the entry shape is
        // bit-identical to what a write would have produced.
        if (connectionId && agentPresenceBroadcaster) {
          const identity = parseKeepaliveIdentity(req.url);
          if (identity) {
            try {
              const icon = iconFromClientName(identity.clientName);
              const color = AGENT_ICON_COLORS[icon] ?? colorFromSeed(identity.colorSeed);
              agentPresenceBroadcaster.setPresence(toBroadcasterKey(connectionId), {
                displayName: identity.displayName,
                icon,
                color,
                // Sentinel `currentDoc` so the badge surfaces in the
                // cross-doc bucket — the client filter at
                // `packages/app/src/lib/agent-presence.ts` drops entries
                // with falsy `currentDoc`, so null would mean the
                // bootstrap entry stays hidden until the agent's first
                // write. The `(connected)` form is human-readable and
                // distinct from any real docName; future click-to-navigate
                // handlers can short-circuit on the leading `(`.
                currentDoc: '(connected)',
                mode: 'idle',
                ts: Date.now(),
              });
            } catch (err) {
              log.error({ err, connectionId }, '[keepalive] presence bootstrap failed');
            }
          }
        }

        const pingTimer = setInterval(() => {
          try {
            ws.ping();
          } catch {
            // Dead socket fires 'close' + 'error' which clean up below.
          }
        }, 30_000);
        pingTimer.unref?.();

        // Presence-ts heartbeat — beats the client-side 5 s TTL filter when
        // an agent sits idle between tool calls (LLM "thinking" 10–30 s).
        // `toBroadcasterKey(connectionId)` translates the raw URL id into
        // the `agent-<id>` map key used by HTTP write handlers via
        // `extractAgentIdentity`; without the prefix `bumpPresenceTs` no-ops
        // because no entry lives under the bare key.
        const tsRefreshTimer = connectionId
          ? setInterval(() => {
              agentPresenceBroadcaster?.bumpPresenceTs(toBroadcasterKey(connectionId));
            }, 3_000)
          : null;
        tsRefreshTimer?.unref?.();

        ws.on('close', () => {
          clearInterval(pingTimer);
          if (tsRefreshTimer !== null) clearInterval(tsRefreshTimer);
          if (!connectionId) return;
          const timer = setTimeout(() => {
            keepaliveGraceTimers.delete(connectionId);
            // If `shutdown()` already ran, the sessionManager + broadcasters
            // may be mid-teardown — racing them is worse than skipping
            // cleanup (TOCTOU between our clearTimeout loop and the timer
            // firing).
            if (shuttingDown) return;
            const work = (async () => {
              log.info({ connectionId }, '[keepalive] grace expired — cleaning up sessions');
              try {
                await sessionManager?.closeAllForAgent(connectionId);
              } catch (err) {
                log.error({ err, connectionId }, '[keepalive] closeAllForAgent failed');
              }
              try {
                agentFocusBroadcaster?.clearFocus(connectionId);
              } catch (err) {
                log.error({ err, connectionId }, '[keepalive] clearFocus failed');
              }
              try {
                agentPresenceBroadcaster?.clearPresence(toBroadcasterKey(connectionId));
              } catch (err) {
                log.error({ err, connectionId }, '[keepalive] clearPresence failed');
              }
              // The closed session's writer is now dead — evaluate maintenance
              // (session-close trigger) off the write path. Gated +
              // fire-and-forget; never blocks session teardown.
              // Scope: this is the ONLY `session-close`-labelled trigger, so it
              // fires only for keepalive-WS sessions. HTTP-only MCP callers,
              // direct Hocuspocus connections, and bulk `closeAll()` on shutdown
              // don't reach it — their dead chains are still reaped by the
              // flush-counter and boot triggers, so coverage is complete; only the
              // `session-close` telemetry label under-counts those paths.
              try {
                await maintenanceCoordinator?.onSessionClose();
              } catch (err) {
                log.error({ err, connectionId }, '[keepalive] maintenance onSessionClose failed');
              }
            })();
            keepaliveGraceInflight.add(work);
            work.finally(() => keepaliveGraceInflight.delete(work));
          }, keepaliveGraceMs);
          timer.unref?.();
          keepaliveGraceTimers.set(connectionId, timer);
          log.info(
            { connectionId, graceMs: keepaliveGraceMs },
            '[keepalive] disconnected — grace timer started',
          );
        });
        ws.on('error', (err: NodeJS.ErrnoException) => {
          if (!handleCollabSocketError(err)) {
            log.error({ err }, 'MCP keepalive WS error');
          }
          ws.terminate();
        });
      });
      return;
    }

    if (req.url?.startsWith('/collab')) {
      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (handleCollabSocketError(err)) return;
        log.error({ err }, 'Upgrade socket error');
      });
      liveUpgradeSockets.add(socket);
      socket.once('close', () => liveUpgradeSockets.delete(socket));
      wss.handleUpgrade(req, socket, head, (ws) => {
        const clientConnection = hocuspocus.handleConnection(
          ws as unknown as WebSocket,
          req as unknown as Request,
        );
        let closedByPolicy = false;
        ws.on('message', (data: ArrayBuffer | Buffer) => {
          if (closedByPolicy) return;
          const bytes = data.byteLength;
          if (bytes > MAX_COLLAB_MESSAGE_BYTES) {
            closedByPolicy = true;
            incrementCollabMessageTooLarge();
            log.warn(
              { event: 'collab-message-too-large', bytes, limit: MAX_COLLAB_MESSAGE_BYTES },
              'Collab WebSocket message rejected before Yjs processing',
            );
            ws.close(1009, 'Message Too Big');
            return;
          }
          clientConnection.handleMessage(new Uint8Array(data as Buffer));
        });
        ws.on('close', (code: number, reason: Buffer) => {
          clientConnection.handleClose({ code, reason: reason.toString() });
        });
        ws.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
            incrementCollabMessageTooLarge();
            log.warn(
              { event: 'collab-message-too-large', limit: MAX_COLLAB_MESSAGE_BYTES },
              'Collab WebSocket frame rejected by ws maxPayload before Yjs processing',
            );
            ws.terminate();
            return;
          }
          if (!handleCollabSocketError(err)) {
            log.error({ err }, 'WebSocket error');
          }
          ws.terminate();
        });
      });
      return;
    }

    socket.destroy();
  };

  httpServer.on('request', onRequest);
  httpServer.on('upgrade', onUpgrade);

  return {
    wss,
    shutdown: async (): Promise<void> => {
      if (shuttingDown) return;
      // Set before destroying sockets so any `'close'` handler that fires as a
      // result sees the flag and skips scheduling fresh grace-cleanup work.
      shuttingDown = true;
      // Destroy every live upgrade socket. Without this the caller's
      // `wss.close()` and `httpServer.close()` steps block on the still-open
      // sockets until their destroy-step timeout fires (see
      // `MountMcpAndApiHandle.shutdown`). Destroying the raw socket also fires
      // each WS's `'close'` handler, so keepalive cleanup still runs.
      for (const socket of liveUpgradeSockets) {
        try {
          socket.destroy();
        } catch {
          // Best-effort — an already-destroyed socket is a no-op.
        }
      }
      liveUpgradeSockets.clear();
      for (const timer of keepaliveGraceTimers.values()) {
        clearTimeout(timer);
      }
      keepaliveGraceTimers.clear();
      if (keepaliveGraceInflight.size > 0) {
        await Promise.allSettled(keepaliveGraceInflight);
      }
    },
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
export function parseKeepaliveConnectionId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    // The second arg is a dummy base so `new URL` accepts path-only inputs.
    const parsed = new URL(url, 'http://localhost');
    const connectionId = parsed.searchParams.get('connectionId');
    return validateAgentId(connectionId);
  } catch {
    return null;
  }
}

/**
 * Identity bundle parsed from the keepalive URL when the cli's MCP shim
 * passes `displayName` + `clientName` + `colorSeed` alongside `connectionId`.
 * All three must be present for the server's WS-upgrade handler to bootstrap
 * a presence entry — the entry shape requires `displayName` + `icon` (derived
 * from `clientName`) + `color` (derived from `colorSeed`), and a partial
 * identity has no useful fallback.
 *
 * Length cap mirrors `validateAgentId` defense-in-depth: log-injection +
 * bounded-cardinality span attribute hygiene. 256 chars is generous for
 * human display names and conservatively below the URL line-length some
 * proxies start truncating at.
 *
 * Exported for unit testing. Never throws.
 */
const MAX_KEEPALIVE_IDENTITY_LEN = 256;

function sanitizeIdentityField(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw.length === 0 || raw.length > MAX_KEEPALIVE_IDENTITY_LEN) return null;
  // Strip control chars (defense-in-depth against log-injection / awareness
  // value pollution). Allow normal printable Unicode (display names may
  // include spaces, punctuation, non-ASCII letters).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitisation
  if (/[ -]/.test(raw)) return null;
  return raw;
}

interface KeepaliveIdentity {
  displayName: string;
  clientName: string;
  colorSeed: string;
}

export function parseKeepaliveIdentity(url: string | undefined): KeepaliveIdentity | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, 'http://localhost');
    const displayName = sanitizeIdentityField(parsed.searchParams.get('displayName'));
    const clientName = sanitizeIdentityField(parsed.searchParams.get('clientName'));
    const colorSeed = sanitizeIdentityField(parsed.searchParams.get('colorSeed'));
    if (displayName === null || clientName === null || colorSeed === null) return null;
    return { displayName, clientName, colorSeed };
  } catch {
    return null;
  }
}

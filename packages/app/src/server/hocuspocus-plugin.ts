/**
 * Vite plugin that integrates Hocuspocus for dev mode. Delegates server
 * construction to `createServer()` from @inkeep/open-knowledge-server; the
 * plugin only adapts that ServerInstance to Vite's lifecycle (config.yml
 * resolution, `OK_TEST_CONTENT_DIR` override, `/api/config` synthesis, sirv
 * content serving, `/collab` + `/collab/keepalive` upgrade routing).
 *
 * `createServer()` is called lazily from `configureServer` (not at module
 * load) because its async init holds the event loop open via @parcel/watcher
 * — module-load invocation makes `vite build` hang after the bundle step.
 * A fresh ServerInstance is created per `configureServer` call so Vite
 * restarts (vite.config.ts / .env edits) don't leave the new httpServer
 * wired to a soon-to-be-destroyed srv.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  ASSET_EXTENSIONS,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
} from '@inkeep/open-knowledge-core';
import {
  createAssetServeMiddleware,
  createServer,
  getLogger,
  handleCollabSocketError,
  parseKeepaliveConnectionId,
  releaseServerLock,
  toBroadcasterKey,
  updateServerLockPort,
} from '@inkeep/open-knowledge-server';
import sirv from 'sirv';
import type { Plugin } from 'vite';
import { WebSocketServer } from 'ws';
import { parse as parseYaml } from 'yaml';
import { computeDevApiConfigResponse } from './api-config-handler.ts';

// Counts `configureServer` invocations so the warn-on-restart message can
// name the count. Referenced in `[collab]` diagnostic logs.
let configureServerInvocations = 0;

const PLUGIN_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
const PROJECT_ROOT = resolve(PLUGIN_DIR, '../../../..');

interface ContentConfig {
  dir: string;
}

// Exported for unit testing. Matches `api-config-handler.ts:computeDevApiConfigResponse`
// extraction pattern — keep the pure logic reachable from a test harness so the
// defaults-fallback path gets regression coverage without spinning up Vite.
export function resolveContentConfig(projectRoot: string): ContentConfig {
  const defaults: ContentConfig = { dir: projectRoot };
  const configPath = resolve(projectRoot, '.ok/config.yml');
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = parseYaml(raw) as Record<string, unknown> | null;
      const content = parsed?.content as Record<string, unknown> | undefined;
      if (typeof content?.dir === 'string') {
        defaults.dir = resolve(projectRoot, content.dir);
      }
    } catch (err) {
      console.warn('[hocuspocus] Failed to parse config:', err);
    }
  }
  return defaults;
}

const contentConfig = resolveContentConfig(PROJECT_ROOT);
// `realpathSync` resolves macOS /tmp → /private/tmp so the watcher and
// persistence layer agree on canonical paths inside test tmpdirs.
const CONTENT_DIR = process.env.OK_TEST_CONTENT_DIR
  ? realpathSync(process.env.OK_TEST_CONTENT_DIR)
  : contentConfig.dir;
const CONTENT_ROOT = relative(PROJECT_ROOT, CONTENT_DIR);

// Without this, fresh clones / worktrees crash on first write.
mkdirSync(CONTENT_DIR, { recursive: true });

// Playwright worker tmpdirs have no `.git/` by default. When a suite needs
// the shadow-repo pipeline (e.g. /api/history, /api/save-version), it sets
// OK_TEST_GIT_ENABLED=1 and this flag opts the plugin into git mode.
const isTestIsolated = Boolean(process.env.OK_TEST_CONTENT_DIR);
const gitEnabledForTest = isTestIsolated && process.env.OK_TEST_GIT_ENABLED === '1';

// No-project ephemeral single-file mode (`ok <file>`) — exercised by the
// browser-fallback e2e. `OK_TEST_SINGLE_DOC_REL_PATH` scopes content to one doc
// and `OK_TEST_PROJECT_DIR` points the server's `.ok/` state at a throwaway
// projectDir distinct from `CONTENT_DIR` (the file's parent), mirroring the
// real ephemeral boot (`bootStartServer`'s `--single-file` / `--project-dir`).
const SINGLE_DOC_REL_PATH = process.env.OK_TEST_SINGLE_DOC_REL_PATH || undefined;
const isEphemeralTest = isTestIsolated && SINGLE_DOC_REL_PATH !== undefined;
const TEST_PROJECT_DIR = process.env.OK_TEST_PROJECT_DIR
  ? realpathSync(process.env.OK_TEST_PROJECT_DIR)
  : undefined;

const KEEPALIVE_GRACE_MS = 10_000;
const MAX_COLLAB_MESSAGE_BYTES = 1024 * 1024;

// Gate the process.once('exit', ...) registration to avoid tripping
// MaxListenersExceededWarning after ~10 Vite restarts. The exit handler
// reads `latestLockDir` inside its closure so a Vite restart that swaps
// the resolved lockDir (content.dir edit, env flip) still releases the
// current server's lock rather than the first invocation's.
let exitHandlerRegistered = false;
let latestLockDir: string | null = null;

export function hocuspocusPlugin(): Plugin {
  return {
    name: 'hocuspocus',
    async configureServer(server) {
      // Per-invocation closure state. On Vite restart the OLD close handler
      // sets its own `shuttingDown = true` on its own binding; the NEW
      // invocation starts fresh. Mirrors boot.ts's closure shape.
      const keepaliveGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
      const keepaliveGraceInflight = new Set<Promise<void>>();
      let shuttingDown = false;

      configureServerInvocations += 1;
      if (configureServerInvocations > 1) {
        console.warn(
          `[collab] configureServer invoked ${configureServerInvocations}× — Vite restarted; spinning up a fresh ServerInstance. The previous srv will be destroyed by its httpServer close handler.`,
        );
      } else {
        console.info(`[collab] configureServer invocation=1 pid=${process.pid}`);
      }

      // Fresh ServerInstance per invocation. The local `currentSrv` is
      // closed over by the close handler below so each configureServer pass
      // destroys the srv IT created (not a later pass's). Same-pid server +
      // shadow locks are idempotent + refcounted, so brief overlap during
      // Vite restart is safe.
      const currentSrv = createServer({
        contentDir: CONTENT_DIR,
        projectDir: TEST_PROJECT_DIR ?? (isTestIsolated ? CONTENT_DIR : PROJECT_ROOT),
        contentRoot: isTestIsolated ? '' : CONTENT_ROOT,
        // Ephemeral single-file mode forces git off (no shadow repo) regardless
        // of OK_TEST_GIT_ENABLED, matching the real ephemeral boot.
        gitEnabled: isEphemeralTest ? false : !isTestIsolated || gitEnabledForTest,
        enableTestRoutes: true,
        quiet: true,
        ...(isEphemeralTest ? { ephemeral: true, singleDocRelPath: SINGLE_DOC_REL_PATH } : {}),
      });

      latestLockDir = currentSrv.lockDir;
      if (!exitHandlerRegistered) {
        exitHandlerRegistered = true;
        // Fires for non-graceful exits where the close handler's
        // `srv.destroy()` never runs. Ownership-guarded. Reads
        // `latestLockDir` from module scope so a Vite restart that swapped
        // the lockDir still releases the current server's lock.
        process.once('exit', () => {
          if (latestLockDir === null) return;
          try {
            releaseServerLock(latestLockDir);
          } catch {
            // Already released by close handler's destroy — fine.
          }
        });
      }

      if (configureServerInvocations === 1) {
        getLogger('hocuspocus').info({ contentDir: CONTENT_DIR }, 'content dir');
      }

      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address();
        if (typeof addr === 'object' && addr !== null) {
          updateServerLockPort(currentSrv.lockDir, addr.port);
        }
      });

      const { hocuspocus, sessionManager, agentFocusBroadcaster, agentPresenceBroadcaster } =
        currentSrv;

      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_COLLAB_MESSAGE_BYTES });
      wss.on('error', (err) => {
        console.error('[collab] WebSocketServer error:', err);
      });

      // `prependListener` intercepts /collab BEFORE Vite's HMR handler.
      //
      // Instrumented because `/collab` has reported-but-non-reproducible
      // failure modes where the HTTP Upgrade never completes (Chrome shows
      // Status: pending, 0 B). The four log lines below pinpoint where in
      // the chain a stuck connection halted:
      //
      //   [collab] upgrade received …     — event reached our listener
      //   [collab] handleUpgrade starting — path matched, pre-ws handoff
      //   [collab] handleUpgrade threw …  — sync throw (e.g. double-upgrade)
      //   [collab] handshake complete …   — 101 sent; hocuspocus takes over
      //
      // If a stuck WS report shows none of these lines for the offending
      // connection, the upgrade never reached this listener.
      server.httpServer?.prependListener('upgrade', (req, socket, head) => {
        if (!req.url?.startsWith('/collab')) return;

        console.info(
          `[collab] upgrade received url=${req.url} protocol=${req.headers['sec-websocket-protocol'] ?? 'none'} host=${req.headers.host ?? 'none'} origin=${req.headers.origin ?? 'none'}`,
        );

        // `ok mcp` holds a persistent WS to /collab/keepalive?connectionId=<id>
        // to register as an active client. Must route as a bare WS — MCP
        // never sends sync-step-1 that Hocuspocus waits for, so routing
        // through hocuspocus.handleConnection would leave the socket
        // half-initialized in the connection registry.
        if (req.url.startsWith('/collab/keepalive')) {
          socket.on('error', (err: NodeJS.ErrnoException) => {
            if (handleCollabSocketError(err)) return;
            console.error('[collab] MCP keepalive socket error:', err);
          });
          console.info(`[collab] keepalive handleUpgrade starting for ${req.url}`);
          try {
            wss.handleUpgrade(req, socket, head, (ws) => {
              // connectionId drives cleanup of agent sessions + focus +
              // presence. Legacy clients without it fall through to the
              // client-side 5s TTL filter.
              const connectionId = parseKeepaliveConnectionId(req.url);

              if (connectionId) {
                const existing = keepaliveGraceTimers.get(connectionId);
                if (existing !== undefined) {
                  clearTimeout(existing);
                  keepaliveGraceTimers.delete(connectionId);
                  console.info(
                    `[keepalive] reconnect during grace — timer cancelled connectionId=${connectionId}`,
                  );
                }
              }

              console.info(`[collab] keepalive handshake complete for ${req.url}`);

              const pingTimer = setInterval(() => {
                try {
                  ws.ping();
                } catch {
                  // Dead socket fires 'close' + 'error' which clean up below.
                }
              }, 30_000);
              pingTimer.unref?.();

              // Client-side TTL filter hides presence entries older than 5s.
              // Write-path calls only fire on MCP edits, so agents between
              // tool calls (LLM thinking 10-30s) would drop off without this
              // 3s bump.
              // `toBroadcasterKey` converts the raw URL id into the
              // `agent-<id>` map key used by HTTP write handlers; without
              // it, `bumpPresenceTs` no-ops because the entry lives under
              // the prefixed key.
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
                  // If destroy already ran, the sessionManager +
                  // broadcasters may be mid-teardown. Racing them is worse
                  // than skipping cleanup.
                  if (shuttingDown) return;
                  const work = (async () => {
                    console.info(
                      `[keepalive] grace expired — cleaning up sessions connectionId=${connectionId}`,
                    );
                    try {
                      await sessionManager.closeAllForAgent(connectionId);
                    } catch (err) {
                      console.error(
                        `[keepalive] closeAllForAgent failed connectionId=${connectionId}`,
                        err,
                      );
                    }
                    try {
                      agentFocusBroadcaster?.clearFocus(connectionId);
                    } catch (err) {
                      console.error(
                        `[keepalive] clearFocus failed connectionId=${connectionId}`,
                        err,
                      );
                    }
                    try {
                      agentPresenceBroadcaster?.clearPresence(toBroadcasterKey(connectionId));
                    } catch (err) {
                      console.error(
                        `[keepalive] clearPresence failed connectionId=${connectionId}`,
                        err,
                      );
                    }
                  })();
                  keepaliveGraceInflight.add(work);
                  work.finally(() => keepaliveGraceInflight.delete(work));
                }, KEEPALIVE_GRACE_MS);
                timer.unref?.();
                keepaliveGraceTimers.set(connectionId, timer);
                console.info(
                  `[keepalive] disconnected — grace timer started connectionId=${connectionId} graceMs=${KEEPALIVE_GRACE_MS}`,
                );
              });
              ws.on('error', (err: NodeJS.ErrnoException) => {
                if (!handleCollabSocketError(err)) {
                  console.error('[collab] keepalive WS error:', err);
                }
                ws.terminate();
              });
            });
          } catch (err) {
            console.error(`[collab] keepalive handleUpgrade threw for ${req.url}:`, err);
            try {
              socket.destroy();
            } catch {
              // Already-destroyed sockets throw on destroy; swallow.
            }
          }
          return;
        }

        // /collab — browser HocuspocusProvider connections. The socket error
        // handler attaches BEFORE handleUpgrade because ECONNRESET during
        // the upgrade handshake fires asynchronously with no listener, which
        // crashes the whole Node process (see websockets/ws#1017).
        socket.on('error', (err: NodeJS.ErrnoException) => {
          if (handleCollabSocketError(err)) return;
          console.error('[collab] Upgrade socket error:', err);
        });

        console.info(`[collab] handleUpgrade starting for ${req.url}`);

        try {
          wss.handleUpgrade(req, socket, head, (ws) => {
            const beforeCount = hocuspocus.getConnectionsCount?.() ?? -1;
            console.info(
              `[collab] handshake complete for ${req.url} (connections before=${beforeCount})`,
            );
            const clientConnection = hocuspocus.handleConnection(ws, req);
            let closedByPolicy = false;
            ws.on('message', (data: ArrayBuffer | Buffer) => {
              if (closedByPolicy) return;
              if (data.byteLength > MAX_COLLAB_MESSAGE_BYTES) {
                closedByPolicy = true;
                console.warn(
                  `[collab] frame rejected: ${data.byteLength} bytes exceeds ${MAX_COLLAB_MESSAGE_BYTES} byte limit`,
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
              if (!handleCollabSocketError(err)) {
                console.error('[collab] WebSocket error:', err);
              }
              ws.terminate();
            });
          });
        } catch (err) {
          console.error(`[collab] handleUpgrade threw for ${req.url}:`, err);
          try {
            socket.destroy();
          } catch {
            // Already-destroyed — swallow.
          }
        }
      });

      // Asset-serve middleware — sirv + Content-Disposition dispatch +
      // fail-closed 404 guard. Policy rationale + branch diagram lives
      // in `asset-serve-middleware.ts`. The factory is extracted as a
      // pure function so it's unit-testable against fake req/res and
      // narrow-integration-testable against a real sirv + tmpdir
      // (mirrors the `api-config-handler.ts` extraction precedent).
      //
      // Registered SYNCHRONOUSLY (front of chain, BEFORE Vite internals)
      // because the asset middleware's 404 guard is load-bearing — it MUST
      // run before Vite's `spaFallback` middleware so unknown asset paths
      // return 404 (not text/html). A post-hook approach
      // (`return () => server.middlewares.use(...)`) would land the
      // middleware AFTER spaFallback, breaking the 404 guard.
      //
      // The Vite-path bypass below pre-empts paths Vite OWNS (publicDir's
      // `/favicon.svg`, Vite-internal `/@vite/...` etc., transform's
      // `?import` query) so we don't shadow Vite's own static-serving and
      // module-transform pipelines. The bypass list is a stable contract
      // documented in the Vite plugin guide (https://vitejs.dev/guide/
      // api-plugin.html#path-normalization-and-vite-internal-paths);
      // updating it on Vite-version bumps is a known maintenance cost.
      const assetMiddleware = createAssetServeMiddleware({
        contentFilter: currentSrv.contentFilter,
        contentSirv: sirv(CONTENT_DIR, { dev: true, dotfiles: false }),
        inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
        assetExtensions: ASSET_EXTENSIONS,
        blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
      });
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        const path = url.split('?')[0] ?? '';
        const queryStart = url.indexOf('?');
        const query = queryStart >= 0 ? url.slice(queryStart) : '';
        // Vite's bare-flag query convention is `?import` / `?html-proxy` (no
        // value). Use URLSearchParams `has()` so `?reimport=1` or
        // `?importMode=auto` don't accidentally bypass the asset middleware.
        const params = query ? new URLSearchParams(query) : null;
        // Vite-owned paths: bypass so Vite's own publicDir / transform /
        // internal middlewares handle them. Order: most-specific first.
        //
        // `/src/` covers Vite's dev-mode source-file serving for raw asset
        // imports (`import x from './foo.png'` resolves to `/src/.../foo.png`
        // with no query — the bare path Vite serves to the browser). Without
        // this bypass the asset middleware claims the path first, calls
        // `contentFilter` against contentDir, finds no match, and 404s — the
        // image-preview-broken symptom in the slash-menu hover
        // preview (`packages/app/src/editor/slash-command/preview-assets/*.png`
        // imports resolve to `/src/editor/slash-command/preview-assets/*.png`).
        //
        // Safe in dev: the dev contentDir is the project root, which has no
        // top-level `src/` directory (sources live under `packages/<name>/src/`
        // — never reachable as a content doc). In prod there is no Vite — the
        // standalone asset middleware in `ok ui` / `ok start` handles `/src/`
        // paths normally and this bypass doesn't apply.
        if (
          path.startsWith('/@vite/') ||
          path.startsWith('/@fs/') ||
          path.startsWith('/@id/') ||
          path === '/@react-refresh' ||
          path.startsWith('/node_modules/') ||
          path.startsWith('/src/') ||
          path === '/favicon.svg' ||
          params?.has('import') ||
          params?.has('html-proxy')
        ) {
          return next();
        }
        return assetMiddleware(req, res, next);
      });

      // `/api/*` routes go through Hocuspocus's onRequest hook; unknown
      // routes must return 404 JSON (NOT fall through to Vite's SPA
      // fallback, which would confuse MCP stdio with an index.html body).
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0];
        if (url?.startsWith('/api/')) {
          // `/api/config` is a dev-only analogue of what `ok ui` serves in
          // prod. Answered here (before the Hocuspocus dispatch) so the
          // first `useCollabUrl` tick gets a valid collabUrl even while
          // extensions are still claiming routes.
          if (url === '/api/config') {
            const addr = server.httpServer?.address();
            const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
            const response = computeDevApiConfigResponse(req.method, port, isEphemeralTest);
            if (response) {
              for (const [name, value] of Object.entries(response.headers)) {
                res.setHeader(name, value);
              }
              res.statusCode = response.status;
              if (response.omitBody) {
                res.end();
              } else {
                res.end(response.body);
              }
              return;
            }
            // Method not GET/HEAD — fall through to 404.
          }
          // biome-ignore lint/suspicious/noExplicitAny: Hocuspocus `hooks()` has no exported payload type for onRequest
          await hocuspocus.hooks('onRequest', { request: req, response: res } as any);
          // Streaming NDJSON handlers call `writeHead(200)` and return
          // before `end()` — `writableEnded` is false but `headersSent` is
          // true. Either means "a handler owns the response"; setting
          // headers here would throw ERR_HTTP_HEADERS_SENT.
          if (res.writableEnded || res.headersSent) return;
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'API route not found', path: url }));
          return;
        }
        next();
      });

      // Close handler is pinned to THIS invocation's `currentSrv` so each
      // configureServer pass destroys the srv it created — Vite restart
      // semantics (close the old httpServer AFTER the new one has wired
      // up) made a module-scope `srv` reference race with itself.
      server.httpServer?.on('close', async () => {
        shuttingDown = true;
        for (const timer of keepaliveGraceTimers.values()) {
          clearTimeout(timer);
        }
        keepaliveGraceTimers.clear();
        if (keepaliveGraceInflight.size > 0) {
          await Promise.allSettled(keepaliveGraceInflight);
        }
        try {
          await currentSrv.destroy();
        } catch (err) {
          console.error('[hocuspocus] srv.destroy() failed:', err);
        }
      });

      getLogger('hocuspocus').info({}, 'WebSocket server ready on /collab');
    },
  };
}

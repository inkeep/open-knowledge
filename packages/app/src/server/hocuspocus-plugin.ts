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
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import {
  ASSET_EXTENSIONS,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
  OK_DIR,
} from '@inkeep/open-knowledge-core';
import {
  AcpThreadManager,
  buildIngressPolicy,
  buildOkMcpStdioCommand,
  createAssetServeMiddleware,
  createCollaborationHost,
  createServer,
  getLogger,
  makeLazyEmbeddingsKeyStore,
  releaseServerLock,
  updateServerLockPort,
} from '@inkeep/open-knowledge-server';
import sirv from 'sirv';
import type { Plugin } from 'vite';
import type { WebSocketServer } from 'ws';
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

// Gate the process.once('exit', ...) registration to avoid tripping
// MaxListenersExceededWarning after ~10 Vite restarts. The exit handler
// reads `latestLockDir` inside its closure so a Vite restart that swaps
// the resolved lockDir (content.dir edit, env flip) still releases the
// current server's lock rather than the first invocation's.
let exitHandlerRegistered = false;
let latestLockDir: string | null = null;

const VITE_WSS_CLOSE_TIMEOUT_MS = 5_000;

function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const terminationErrors: unknown[] = [];
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch (err) {
          terminationErrors.push(err);
        }
      }
      const timeoutError = new Error(
        `WebSocket server close timed out after ${VITE_WSS_CLOSE_TIMEOUT_MS}ms`,
      );
      reject(
        terminationErrors.length === 0
          ? timeoutError
          : new AggregateError(
              [timeoutError, ...terminationErrors],
              'WebSocket server close timed out and client termination failed',
            ),
      );
    }, VITE_WSS_CLOSE_TIMEOUT_MS);
    timer.unref?.();

    const settle = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    try {
      wss.close(settle);
    } catch (err) {
      settle(err);
    }
  });
}

export function hocuspocusPlugin(): Plugin {
  const activeRuntimeTeardowns = new Set<() => Promise<void>>();
  return {
    name: 'hocuspocus',
    async buildEnd() {
      const results = await Promise.allSettled(
        [...activeRuntimeTeardowns].map((teardown) => teardown()),
      );
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, 'Hocuspocus Vite teardown failed');
    },
    async configureServer(server) {
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
        ...(isTestIsolated ? { configHomedirOverride: CONTENT_DIR } : {}),
        // Ephemeral single-file mode forces git off (no shadow repo) regardless
        // of OK_TEST_GIT_ENABLED, matching the real ephemeral boot.
        gitEnabled: isEphemeralTest ? false : !isTestIsolated || gitEnabledForTest,
        enableTestRoutes: true,
        quiet: true,
        // Read the same 0600 ~/.ok/secrets.yml the production boot does, so the
        // dev server resolves stored embeddings keys (dev/prod parity — without
        // this, semantic search only ever resolves the env key / keyless).
        embeddingsKeyStore: makeLazyEmbeddingsKeyStore(),
        // Vite serves the React app from the SAME listener this lock
        // advertises, so the dev process genuinely mounts the UI surface.
        capabilities: ['http', 'ws', 'ui'],
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
          updateServerLockPort(currentSrv.lockDir, addr.port, `http://localhost:${addr.port}`);
        }
      });

      const {
        hocuspocus,
        nativeApi,
        sessionManager,
        agentFocusBroadcaster,
        agentPresenceBroadcaster,
      } = currentSrv;

      // ACP thread host — the dev twin of boot.ts's construction (the
      // documented dual-upgrade-handler drift hazard applies to this whole
      // plugin; keep the two in step). Ephemeral test mode mirrors prod's
      // off-switch: no manager, `/collab/thread` fail-closes.
      const acpThreadManager = isEphemeralTest
        ? null
        : new AcpThreadManager({
            contentDir: CONTENT_DIR,
            localDir: currentSrv.lockDir,
            // Match boot.ts: transcripts under `~/.ok/threads`, cwd-scoped, with
            // the per-project dir read back for pre-move threads.
            globalDir: resolve(homedir(), OK_DIR),
            registry: currentSrv.acpRegistry,
            permissions: currentSrv.acpPermissions,
            sessionManager,
            agentPresenceBroadcaster,
            resolveEmbed: currentSrv.resolveEmbed,
            isExcludedPath: (rel) => currentSrv.contentFilter.isExcluded(rel),
            isIgnoredPath: (rel) => currentSrv.contentFilter.isPathIgnored(rel),
            getLoadedDocText: (docName) =>
              hocuspocus.documents.get(docName)?.getText('source').toString() ?? null,
            getServerUrl: () => {
              const addr = server.httpServer?.address();
              const port = typeof addr === 'object' && addr !== null ? addr.port : 5173;
              return `http://localhost:${port}`;
            },
            // Non-HTTP agents (e.g. Claude's ACP adapter) get a stdio `ok mcp`
            // shim pinned to this dev port. Relies on `open-knowledge` being on
            // PATH here (no CLI entrypoint to resolve in the Vite dev server).
            getMcpStdioCommand: () => {
              const addr = server.httpServer?.address();
              const port = typeof addr === 'object' && addr !== null ? addr.port : 5173;
              return buildOkMcpStdioCommand(undefined, port);
            },
            log: getLogger('acp-threads'),
          });
      // Rehydrate archived threads before the first `list` can arrive.
      await acpThreadManager?.init();

      const collaborationHost = createCollaborationHost({
        hocuspocus,
        log: getLogger('hocuspocus'),
        sessionManager,
        agentFocusBroadcaster,
        agentPresenceBroadcaster,
        maintenanceCoordinator: currentSrv.maintenanceCoordinator,
        acpThreadManager,
      });
      server.httpServer?.prependListener('upgrade', collaborationHost.handleUpgrade);

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
        // Dev serves on the Vite loopback port with no resolved server
        // runtime — the loopback-only default admits the localhost Hosts
        // the browser actually sends. Known dev-mode limitation: under
        // `vite --host` (LAN testing from a phone/second machine) content
        // assets 403 while the shell still loads, so images render broken —
        // there is no dev-side publicUrl to admit the LAN Host. For LAN/tailnet
        // testing use `ok start --bind <ip>` + `OK_PUBLIC_URL`, which builds a
        // real policy that admits the declared Host.
        ingressPolicy: buildIngressPolicy({}),
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
          // Natively-routed /api/* groups (ServerInstance.nativeApi) dispatch
          // BEFORE the legacy Hocuspocus hook — the dev twin of the Hono
          // app's above-the-catch-all mount in `mountMcpAndApi`. The shared
          // pipeline runs either way, so gate behavior is identical.
          if (await nativeApi.dispatch(req, res)) return;
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

      let teardownPromise: Promise<void> | undefined;
      const teardown = (): Promise<void> => {
        teardownPromise ??= (async () => {
          const errors: unknown[] = [];
          const run = async (label: string, action: () => Promise<void>): Promise<void> => {
            try {
              await action();
            } catch (err) {
              errors.push(err);
              getLogger('hocuspocus').error(
                { err },
                `Vite collaboration teardown failed: ${label}`,
              );
            }
          };
          server.httpServer?.off('upgrade', collaborationHost.handleUpgrade);
          await run('ACP thread manager', async () => acpThreadManager?.destroy());
          await run('collaboration host', () => collaborationHost.shutdown());
          await run('WebSocket server', () => closeWebSocketServer(collaborationHost.wss));
          await run('server instance', () => currentSrv.destroy());
          if (errors.length > 0)
            throw new AggregateError(errors, 'Vite collaboration teardown failed');
        })();
        void teardownPromise.finally(() => activeRuntimeTeardowns.delete(teardown)).catch(() => {});
        return teardownPromise;
      };
      activeRuntimeTeardowns.add(teardown);
      server.httpServer?.on('close', () => {
        void teardown().catch((err) =>
          getLogger('hocuspocus').error({ err }, 'HTTP close fallback teardown failed'),
        );
      });

      getLogger('hocuspocus').info({}, 'WebSocket server ready on /collab');
    },
  };
}

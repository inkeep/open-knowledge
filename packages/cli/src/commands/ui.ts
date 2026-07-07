/**
 * `open-knowledge ui` — serves the React editor UI as a sibling to `ok start`.
 *
 * Default port `DEFAULT_UI_PORT` (39847 — quirky, IANA-unassigned, unlikely to
 * collide with other dev servers); `PORT` env (set by Claude via
 * `launch.json` + `autoPort:true`) and `--port` flag override. When the
 * default port is busy, the bind layer falls back to kernel-allocation
 * (port 0) so multi-project concurrency stays mechanical rather than
 * aspirational — guarding against silent cross-project collisions.
 * The user-facing URL is always sourced from `ui.lock.port`.
 *
 * Claude's `launch.json` uses a distinct port `LAUNCH_JSON_PORT`
 * (39848) — see that constant's docstring for why the two must differ
 * (the lock-collision proxy bridges them; the same-port "already-running"
 * exit-0 path empirically fails Claude's preview pane).
 *
 * Acquires `<lockDir>/ui.lock` so MCP tools can advertise preview URLs
 * pointing at this process.
 *
 * Exposes `GET /api/config` with `{collabUrl, previewUrl, port}`, derived
 * from the `ok start` lockfile. The React app reads it on mount to bootstrap
 * HocuspocusProvider.
 *
 * Static-asset serving — app bundle from `dist/public` (published CLI) or
 * `packages/app/dist` (monorepo dev), plus filter-aware content serving over
 * `contentDir`. `ok ui` is the sole server of the React bundle; `ok start`
 * no longer serves static assets.
 *
 * Lock-collision handling: when another `ok ui` already holds `ui.lock`,
 * `resolveUiLockCollision` decides between three modes — silent exit (same
 * port), reverse HTTP proxy (different port with live upstream), or timeout
 * (upstream still binding). The proxy uses only `node:http` (see
 * `ui-proxy.ts`).
 *
 * Safety-net self-shutdown: a 12-hour timer self-terminates the UI if the
 * parent `ok start` ever crashes silently without sending SIGTERM
 * (idle-shutdown sends SIGTERM as its final pre-exit step, but a hard crash
 * doesn't get there). The default 12h is comfortably longer than any
 * legitimate uninterrupted editing session, and short enough that a
 * forgotten UI doesn't linger overnight. Cancelled by `handle.release()`.
 */
import type { Server as HttpServer, ServerResponse } from 'node:http';
import {
  ASSET_EXTENSIONS,
  DEFAULT_SERVER_HOST,
  defaultScheduler,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
  type Scheduler,
} from '@inkeep/open-knowledge-core';
import type { Config } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { emitProblem } from './ui-problem.ts';
import {
  type ProxyServerHandle,
  proxyRequest,
  proxyUpgrade,
  rejectIfNotLoopbackApi,
  rejectUpgradeIfNotLoopback,
  startProxyServer,
} from './ui-proxy.ts';

/** 12 hours — default safety-net interval. */
export const DEFAULT_UI_SAFETY_NET_MS = 12 * 60 * 60 * 1000;

/**
 * Default UI port — what `ok ui` actually binds. Picked to be quirky and
 * IANA-unassigned so it almost never collides with another local dev
 * server. The bind layer falls back to kernel-allocation (port 0) on
 * `EADDRINUSE`, so a collision degrades to "preview pane misses, banner
 * URL still works" rather than a hard failure.
 */
export const DEFAULT_UI_PORT = 39847;

/**
 * Port written into `.claude/launch.json`'s `port` field — what Claude
 * Code's preview pane uses as its probe / spawn target. **Must differ
 * from `DEFAULT_UI_PORT`** so the lock-collision handler enters proxy
 * mode (`requestedPort ≠ lockPort` → bind + forward) rather than the
 * "already-running" exit-0 path. The exit-0 path empirically fails
 * Claude's preview pane (the subprocess exits before the pane can
 * attach), so the design relies on the proxy bridge:
 *
 *   `ok start` → spawns `ok ui` → binds 39847 → writes `ui.lock`
 *   Claude preview → spawns `ok ui` with `PORT=39848`
 *     → new `ok ui` sees lock collision, `requestedPort(39848) ≠ lockPort(39847)`
 *     → proxy mode: binds 39848, forwards to 39847
 *   Preview pane → `http://localhost:39848` → proxy → real UI
 *
 * Picked adjacent to `DEFAULT_UI_PORT` (39848 vs 39847) so the pairing
 * is mnemonic; both are quirky/IANA-unassigned.
 */
export const LAUNCH_JSON_PORT = 39848;

export interface UiServerHandle {
  /**
   * All bound HTTP servers. In two-socket-loopback mode (default) this has
   * length 2 — one IPv6 loopback (`[::1]`), one IPv4 loopback (`127.0.0.1`).
   * When a caller passes an explicit `host`, length is 1. Callers that want
   * to close the listener must close ALL servers; use the exported
   * `closeHttpServers` helper.
   */
  httpServers: HttpServer[];
  port: number;
  /** Release the lock + cancel the safety-net timer. Idempotent. */
  release: () => void;
  /** Cancel only the safety-net timer (release() also calls this). Idempotent. */
  detachSafetyNet: () => void;
  /** Reset the safety-net timer as if activity just occurred. Called on every
   *  `/api/config` hit so an actively-used UI doesn't disconnect at 12h. */
  nudgeSafetyNet: () => void;
  /** Destroy any upgrade-detached WebSocket sockets (`/collab` forwarding
   *  pairs). Called from shutdown paths before `closeHttpServers` so the
   *  servers' close-callbacks can fire promptly — `httpServer.close()` does
   *  not track upgrade-detached sockets and would otherwise wait on them
   *  forever. Idempotent. */
  drainUpgradeSockets: () => void;
}

/**
 * Close every HTTP server in a `UiServerHandle` and resolve when all have
 * fully released their listening sockets. Use instead of touching
 * `handle.httpServers` directly so the two-socket lifecycle is centralized.
 */
export async function closeHttpServers(servers: HttpServer[]): Promise<void> {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((done) => {
          s.close(() => done());
        }),
    ),
  );
}

interface StartUiServerOptions {
  config: Config;
  cwd: string;
  port: number;
  /**
   * When `true` and the requested `port` is in use (`EADDRINUSE`), the bind
   * layer retries once with port 0 (kernel-allocation). Set by the action
   * handler when the port came from `DEFAULT_UI_PORT` rather than an
   * explicit `--port` flag or `PORT` env value — operator-explicit ports
   * never silently move. Preserves the multi-project bind guarantee when
   * the default is busy.
   */
  fallbackToKernel?: boolean;
  /**
   * Bind host. Undefined (default) triggers two-socket loopback mode: the
   * server is bound twice on the same port — once on `[::1]` (IPv6 loopback)
   * and once on `127.0.0.1` (IPv4 loopback). Any subsequent bind attempt on
   * the same port from either family fails loud with EADDRINUSE.
   *
   * Passing an explicit host (e.g. `'127.0.0.1'`, `'::1'`, `'0.0.0.0'`, `'::'`)
   * degrades to single-socket binding on that host. Tests and operator
   * overrides can still target a specific family.
   */
  host?: string;
  /** Override the 12h safety-net interval. Tests pass a small value. */
  safetyNetMs?: number;
  /** Scheduler override for tests (precedent #13b — implicit time-coupling is a smell). */
  scheduler?: Scheduler;
  /**
   * Optional callback invoked by the safety-net timer right before it tears
   * down the http listener + lock. Tests use this to assert the safety-net
   * actually fired (rather than coincidentally being shut down by something
   * else). Production use case: future hook for metrics / logging.
   */
  onSafetyNet?: () => void;
  /**
   * Override the directory the SPA bundle is served from. Defaults to the
   * published `dist/public` (or the monorepo `app/dist`) resolved from this
   * module's location. Explicit override is primarily a test seam — serve a
   * controlled tmp dist — but also lets an embedder point at a custom build.
   */
  assetDir?: string;
}

/**
 * Boot the UI server. Exposed for tests so they can drive the HTTP surface
 * without having to go through Commander.
 */
export async function startUiServer(opts: StartUiServerOptions): Promise<UiServerHandle> {
  const { existsSync } = await import('node:fs');
  const { createServer: createHttpServer } = await import('node:http');
  const { resolve } = await import('node:path');
  const {
    acquireUiLock,
    clearArmedPaneTarget,
    createAssetServeMiddleware,
    createContentFilter,
    readArmedPaneTarget,
    readServerLock,
    releaseUiLock,
    updateUiLockPort,
  } = await import('@inkeep/open-knowledge-server');
  const { default: sirv } = await import('sirv');
  const { resolveContentDir, resolveLockDir } = await import('@inkeep/open-knowledge-server');

  const contentDir = resolveContentDir(opts.config, opts.cwd);
  // Lock anchor is the project root (cwd), not contentDir — must match
  // `server-factory.ts`'s `<projectDir>/.ok/local/server.lock` so the UI
  // server can be discovered alongside the data server when `content.dir`
  // is a sub-folder (git-root-promotion case).
  const lockDir = resolveLockDir(opts.cwd);

  // Acquire lock before any side effects. `port: 0` is the sentinel while
  // the server is binding; `updateUiLockPort` rewrites after `listen()`.
  acquireUiLock(lockDir, { port: 0, worktreeRoot: opts.cwd });

  // Locate the built React app. Priority: published dist/public (bundled CLI)
  // first, then monorepo dev paths.
  const cliDir = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
  const assetPaths = [
    resolve(cliDir, 'public'), // npm install: dist/public/ (bundled)
    resolve(cliDir, '../../app/dist'), // monorepo dev from src/
    resolve(cliDir, '../../../app/dist'), // monorepo dev from dist/
  ];
  // Explicit override (test seam / embedder) wins; otherwise resolve the
  // published or monorepo build location.
  const assetDir = opts.assetDir ?? assetPaths.find((p) => existsSync(p));
  // `dev: true` resolves each request against live disk instead of a boot-time
  // file map, so an in-place rebuild (or in-place `npm i -g` upgrade) that
  // writes new content-hashed bundles is served without a restart. The
  // production-mode boot map otherwise 404s bundles that already exist on disk
  // while still streaming a fresh index.html that references them — the
  // blank-screen bug. `etag: true` adds If-None-Match revalidation (304 on
  // unchanged hashed files); `dev` mode sends `no-store` without it. A prior
  // `immutable: true` was inert here — sirv only emits Cache-Control when
  // `maxAge` is set, which it never was.
  const staticHandler = assetDir
    ? sirv(assetDir, { single: true, gzip: true, etag: true, dev: true, extensions: [] })
    : null;

  // Filter-aware content asset serving — shared `createAssetServeMiddleware`
  // applies the same Content-Disposition policy + 404 fail-closed guard the
  // dev-plugin path uses, so dev and prod cannot diverge on serve semantics.
  //
  // Use `dev: true` so sirv resolves files lazily instead of recursively
  // crawling the entire content root at boot. Repo-root content dirs often
  // include huge trees (`node_modules`, build artifacts) and can contain
  // broken links from package-manager swaps; eager traversal makes UI boot
  // fail before it has served a single request.
  //
  // `dotfiles: false` still keeps `.ok/` out of reach.
  // `extensions: []` disables sirv's default `['html', 'htm']` fallback —
  // without this, a request to `/docs/evil` transparently resolves
  // `docs/evil.html` and serves it as `text/html`, bypassing the
  // Content-Disposition dispatch (which matches on the requested URL's
  // extension). Refusing extension inference confines lookup to the
  // literal requested URL.
  //
  // The asset-serve middleware itself only fires when `contentSirv` is
  // present; if `contentDir` is missing we skip filter construction and
  // route everything through the SPA static handler (matches the
  // pre-middleware behavior for missing-contentDir setups).
  const assetServeMiddleware = existsSync(contentDir)
    ? createAssetServeMiddleware({
        contentFilter: createContentFilter({
          projectDir: opts.cwd,
          contentDir,
        }),
        contentSirv: sirv(contentDir, { dotfiles: false, dev: true, extensions: [] }),
        inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
        assetExtensions: ASSET_EXTENSIONS,
        blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
      })
    : null;

  // Resolved port — filled in after listen(). /api/config reads from this so
  // the advertised `port` matches what the kernel actually bound (matters
  // when opts.port is 0).
  let resolvedPort = opts.port;

  // Forward-reference for the safety-net nudge (set below after the timer is
  // armed). The HTTP handler closes over this indirection so it picks up the
  // live callback once the timer is in place.
  let apiConfigNudge: (() => void) | null = null;

  // Request handler — the same function services every bound server (both
  // [::1] and 127.0.0.1 in two-socket-loopback mode, or the single socket
  // when a caller passes an explicit host).
  const requestHandler = (req: import('node:http').IncomingMessage, res: ServerResponse) => {
    const url = req.url?.split('?')[0];

    // Claude-pane deep-link redirect (Claude Code Desktop flow only).
    // `preview_start` opens the pane at the UI root with no way to pass a target
    // doc, so the agent arms one via `preview_url({ armPaneTarget })`, which
    // writes a TTL-bounded hash route here. On the base-open we 302 straight to
    // that route so the pane lands ON the doc instead of rendering root and then
    // client-navigating. Inert for every other host: nothing else arms a target,
    // so `readArmedPaneTarget` returns null and we fall through to serve root.
    //
    // The target is a hash fragment (`#/doc`) the server never sees on the
    // follow-up request, so a naive 302 would loop (GET / → 302 → GET / → 302 …).
    // Consuming the target as we emit the redirect breaks the loop — the second
    // GET / finds nothing armed and serves the SPA — and also stops an in-TTL
    // reload of a deep link from being yanked back to the armed doc.
    // `PaneTargetLanding` in the app remains a client-side backstop.
    if (req.method === 'GET' && (url === '/' || url === '')) {
      const armed = readArmedPaneTarget(lockDir);
      // CRLF guard: never let a stray newline in the route split the response
      // into injected headers (the route is built from a doc/folder name).
      if (armed && !/[\r\n]/.test(armed)) {
        clearArmedPaneTarget(lockDir);
        res.statusCode = 302;
        res.setHeader('Location', `/${armed}`);
        res.setHeader('Cache-Control', 'no-store');
        res.end();
        return;
      }
    }

    // Bare `/` and the empty path: rewrite to `/index.html` so sirv serves
    // the SPA shell. The static handler is configured with `extensions: []`
    // (a security choice — without it, `/foo` would transparently serve
    // `/foo.html` and bypass the Content-Disposition dispatch which keys
    // off the requested URL's extension). That suppression also disables
    // sirv's implicit directory-index resolution, so `/` ends up as a 404
    // even though `single: true` is set. The cleanest fix is to rewrite
    // the entry path explicitly here, before any middleware runs, rather
    // than re-enabling extension inference globally.
    if (url === '/' || url === '') {
      req.url = '/index.html';
    }

    // Loopback gate for the /api/* surface. The proxy below rewrites the Host
    // header to `localhost:<upstream-port>` and the upstream sees the proxy's
    // own loopback peer address — so the upstream's DNS-rebinding + loopback
    // checks are trivially satisfied for anything that reaches the proxy. We
    // re-apply the same gate here at the proxy front so a non-loopback peer,
    // attacker-controlled Host (DNS-rebind), or non-loopback Origin can never
    // forward through. Mirrors `api-extension.ts` so the proxy doesn't fall
    // behind the upstream as new defenses land there.
    if (url?.startsWith('/api/')) {
      if (rejectIfNotLoopbackApi(req, res)) return;
    }

    // DELETE /api/config — one-shot consume of the armed pane target. The app
    // calls this AFTER it has applied the target on a base-open, so a reload
    // within the TTL doesn't re-navigate. Consume-on-apply (not on read) keeps
    // the GET non-destructive — other /api/config readers (the collab-URL hook)
    // must not race-consume the target before the lander applies it.
    if (url === '/api/config' && req.method === 'DELETE') {
      clearArmedPaneTarget(lockDir);
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 204;
      res.end();
      return;
    }

    // GET /api/config — zero-ceremony bootstrap for the React app. Reads the
    // collab server.lock on demand so a later `ok start` shows up without
    // requiring a UI restart.
    if (url === '/api/config' && (req.method === 'GET' || req.method === 'HEAD')) {
      // Nudge the safety-net so an actively-polling client (the React
      // `useCollabUrl` hook, default ~2s cadence while unresolved) never lets
      // the 12h timer fire mid-session.
      apiConfigNudge?.();
      const lock = readServerLock(lockDir);
      // Advertise the collab WebSocket on the **same origin** the shell
      // loaded from — `ok ui` forwards `/collab` upgrades to the collab
      // server in its `on('upgrade')` handler below. Same-origin avoids the
      // cross-port WS attempt that gets refused by sandboxed in-app preview
      // panes (e.g. Claude Code's preview browser locked to one URL). The
      // `/api/config` route already passed `rejectIfNotLoopbackApi` above, so
      // `req.headers.host` is guaranteed present and loopback-shaped; the
      // `?? <localhost>` fallback is defense-in-depth only.
      const sameOriginHost = req.headers.host ?? `localhost:${resolvedPort}`;
      const collabUrl = lock && lock.port > 0 ? `ws://${sameOriginHost}/collab` : null;
      // Armed pane-target override (route fragment, TTL-bounded). The app reads
      // this on a base-open to deep-link the Claude pane; null when unarmed/stale.
      const paneTarget = readArmedPaneTarget(lockDir);
      const body = JSON.stringify({ collabUrl, previewUrl: null, port: resolvedPort, paneTarget });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      // `nosniff` — defense in depth against a misconfigured intermediate or
      // browser that would otherwise content-sniff the response body.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.statusCode = 200;
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(body);
      }
      return;
    }

    // All other /api/* requests: transparently proxy to the collab server
    // (`ok start`). The React app makes same-origin `fetch('/api/pages')`,
    // `/api/backlinks`, `/api/history`, etc.; post-lifecycle-split those
    // endpoints only exist on `ok start`, NOT `ok ui`. Without this proxy
    // the React app fetches would receive the SPA-fallback HTML and fail to
    // JSON.parse. When the collab server is absent (no server.lock
    // or port=0), we emit RFC 9457 problem+json so client-side
    // `ProblemDetailsSchema.safeParse` flows surface the actionable
    // "Start `ok start`" title instead of a generic HTTP-503 fallback.
    if (url?.startsWith('/api/')) {
      apiConfigNudge?.();
      const lock = readServerLock(lockDir);
      if (!lock || lock.port <= 0) {
        emitProblem(
          res,
          503,
          'urn:ok:error:collab-server-not-running',
          'Collab server not running. Start `ok start` or run `ok status`.',
          `Path: ${url}`,
        );
        return;
      }
      proxyRequest(req, res, {
        // Dial the data server on the same numeric IPv4 loopback it binds — see
        // DEFAULT_SERVER_HOST's JSDoc for why not `localhost`.
        upstreamHost: DEFAULT_SERVER_HOST,
        upstreamPort: lock.port,
      });
      return;
    }

    // SPA-bundle assets live under `/assets/` (Vite's `build.assetsDir`
    // default). Try the static handler first for that prefix so hashed
    // bundle files — fonts (.woff2), sprite sheets (.svg), bundled images
    // — are served from `dist/.../assets/` instead of getting intercepted
    // by `createAssetServeMiddleware`. The middleware's fail-closed branch
    // refuses to fall through for known asset extensions when contentSirv
    // misses, which would 404 every SPA-bundled woff2/png/svg whose name
    // doesn't happen to also exist under `<contentDir>/assets/`.
    //
    // Fall through to the content middleware when sirv misses — `single:
    // true` + `extensions: []` means a missing file WITH an extension
    // calls `next()` (instead of returning the SPA shell), so user
    // uploads at `<contentDir>/assets/foo.png` still serve.
    if (staticHandler && url?.startsWith('/assets/')) {
      staticHandler(req, res, () => {
        if (assetServeMiddleware) {
          assetServeMiddleware(req, res, () => notFoundStatic(res));
        } else {
          notFoundStatic(res);
        }
      });
      return;
    }

    // Content files (markdown + assets) served via the shared asset-serve
    // middleware — same Content-Disposition policy (inline / attachment) +
    // fail-closed 404 guard that the dev plugin uses. Falls through to the
    // SPA static handler when the content filter excludes the path or sirv
    // doesn't recognize it.
    if (assetServeMiddleware) {
      assetServeMiddleware(req, res, () => {
        if (staticHandler) {
          staticHandler(req, res);
        } else {
          notFoundStatic(res);
        }
      });
      return;
    }

    // SPA fallback.
    if (staticHandler) {
      staticHandler(req, res);
      return;
    }

    notFoundStatic(res);
  };

  // HTTP/1.1 upgrade handler — forwards `/collab` WebSocket upgrades to the
  // collab server (`ok start`) so the React shell can talk to Hocuspocus on
  // the SAME origin it loaded from. Without this, the shell's WS attempt
  // would have to dial a different port (the collab one) — which works in
  // a regular browser tab but is refused by sandboxed in-app preview panes
  // (e.g. Claude Code's preview browser locked to one URL).
  //
  // Tracked socket pairs are drained explicitly on shutdown via
  // `drainUpgradeSockets` below — `httpServer.close()` waits on its
  // connection set but does not include upgrade-detached sockets under all
  // runtimes, so without the drain a long-lived WS can keep `release()`
  // from completing (then no `process.exit`-class fallback ever fires).
  const upgradeSocketsForShutdown = new Set<import('node:stream').Duplex>();
  const handleUpgrade = (
    req: import('node:http').IncomingMessage,
    clientSocket: import('node:stream').Duplex,
    head: Buffer,
  ): void => {
    if (rejectUpgradeIfNotLoopback(req, clientSocket)) return;
    const url = req.url?.split('?')[0] ?? '';
    // Hocuspocus mounts on `/collab` and `/collab/keepalive` only; tighter
    // than `startsWith('/collab')` so `/collabsy` and similar near-prefixes
    // don't accidentally tunnel through to the collab server.
    if (url !== '/collab' && !url.startsWith('/collab/')) {
      clientSocket.destroy();
      return;
    }
    const lock = readServerLock(lockDir);
    if (!lock || lock.port <= 0) {
      console.warn(
        JSON.stringify({
          event: 'ok-ui-upgrade-no-collab-lock',
          url,
          reason: 'server.lock missing or port unbound — is `ok start` running?',
        }),
      );
      clientSocket.destroy();
      return;
    }
    // Dial the data server on the same numeric IPv4 loopback it binds — see
    // DEFAULT_SERVER_HOST's JSDoc for why not `localhost`.
    proxyUpgrade(
      req,
      clientSocket,
      head,
      DEFAULT_SERVER_HOST,
      lock.port,
      upgradeSocketsForShutdown,
    );
  };
  const drainUpgradeSockets = (): void => {
    for (const sock of upgradeSocketsForShutdown) {
      try {
        sock.destroy();
      } catch {
        // best-effort — already destroyed sockets are no-ops.
      }
    }
    upgradeSocketsForShutdown.clear();
  };

  // BIND STRATEGY
  //
  // When `opts.host` is undefined (default), we bind two separate HTTP
  // servers on the same port: one on `[::1]` (IPv6 loopback), one on
  // `127.0.0.1` (IPv4 loopback). This is "two-socket loopback" mode.
  //
  // Why not `::` + `ipv6Only:false`? That
  // doesn't enforce EADDRINUSE on macOS — a second `127.0.0.1` bind
  // succeeds even when the IPv6 wildcard is already claimed. The only way
  // to get cross-family collision-
  // fail-loud on macOS is to bind both families explicitly.
  //
  // When `opts.host` is set (e.g. `-H 127.0.0.1`), we degrade to a
  // single-socket bind so callers opting into a specific family get
  // exactly that behavior.
  //
  // Sequencing: bind IPv6 first (the kernel assigns the port when
  // `opts.port === 0`), then bind IPv4 at the resolved port. If the
  // IPv4 bind fails (EADDRINUSE, EACCES, etc.), close the IPv6 server
  // and release the lock before propagating the error.
  const bindTargets: string[] = opts.host === undefined ? ['::1', '127.0.0.1'] : [opts.host];
  const httpServers: HttpServer[] = [];
  let boundPort = opts.port;

  // Bind loop with optional fallback. The first iteration uses the requested
  // port; if that fails with EADDRINUSE and `fallbackToKernel: true`, we
  // close any partial binds, reset `boundPort` to 0, and retry once. After
  // a successful first listen the kernel-resolved port is pinned for any
  // subsequent loopback families, so the IPv4 bind never re-triggers the
  // fallback (preserves the two-socket-loopback EADDRINUSE-fail-loud
  // invariant for any port the kernel actually assigned us).
  const isEAddrInUse = (err: unknown): boolean =>
    err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';

  const tearDownPartialBinds = async (): Promise<void> => {
    await Promise.all(
      httpServers.splice(0).map(
        (s) =>
          new Promise<void>((done) => {
            try {
              s.close(() => done());
            } catch {
              done();
            }
          }),
      ),
    );
  };

  const runBindLoop = async (initialPort: number): Promise<void> => {
    boundPort = initialPort;
    for (const host of bindTargets) {
      const server = createHttpServer(requestHandler);
      server.on('upgrade', handleUpgrade);
      httpServers.push(server);
      await new Promise<void>((done, fail) => {
        const onError = (err: Error) => fail(err);
        server.once('error', onError);
        server.listen(boundPort, host, () => {
          server.off('error', onError);
          const addr = server.address();
          if (typeof addr === 'object' && addr !== null) {
            // Pin the resolved port so the next bind in the loop uses the
            // same port (matters when opts.port was 0).
            boundPort = addr.port;
          }
          done();
        });
      });
    }
  };

  try {
    try {
      await runBindLoop(opts.port);
    } catch (err) {
      if (opts.fallbackToKernel === true && isEAddrInUse(err)) {
        // Default-port collision: tear down whichever bind half-completed
        // and retry once with kernel-allocation. Operator-explicit ports
        // (no fallback flag set) propagate the error as before. The
        // resolveRequestedPort contract guarantees fallbackToKernel is
        // only true when opts.port came from DEFAULT_UI_PORT (> 0), so
        // there is no "port=0 fell back to port=0" infinite-loop risk.
        await tearDownPartialBinds();
        await runBindLoop(0);
      } else {
        throw err;
      }
    }
  } catch (err) {
    // Any partial binds need to be torn down before we propagate.
    await tearDownPartialBinds();
    try {
      releaseUiLock(lockDir);
    } catch {
      // Release is best-effort; the primary failure is more informative.
    }
    throw err;
  }

  const realPort = boundPort;
  resolvedPort = realPort;
  updateUiLockPort(lockDir, realPort);

  // Schedule the safety-net self-shutdown. The timer is cancelled by
  // `release()` (the canonical "I'm shutting down" signal) so an
  // operator-driven SIGTERM never trips it. Each `/api/config` hit nudges
  // the deadline forward so an actively-used UI never fires the safety-net.
  const scheduler = opts.scheduler ?? defaultScheduler;
  const safetyNetMs = opts.safetyNetMs ?? DEFAULT_UI_SAFETY_NET_MS;
  let safetyNetHandle: ReturnType<typeof scheduler.setTimeout> | null = null;
  let safetyNetCancelled = false;
  let lockReleased = false;

  const detachSafetyNet = (): void => {
    if (safetyNetCancelled) return;
    safetyNetCancelled = true;
    if (safetyNetHandle !== null) {
      scheduler.clearTimeout(safetyNetHandle);
      safetyNetHandle = null;
    }
  };

  const release = (): void => {
    detachSafetyNet();
    if (lockReleased) return;
    lockReleased = true;
    try {
      releaseUiLock(lockDir);
    } catch {
      // Release is best-effort — another cleanup may have raced us.
    }
  };

  const armSafetyNet = (): void => {
    if (safetyNetCancelled || safetyNetMs <= 0) return;
    if (safetyNetHandle !== null) {
      scheduler.clearTimeout(safetyNetHandle);
      safetyNetHandle = null;
    }
    safetyNetHandle = scheduler.setTimeout(() => {
      safetyNetHandle = null;
      // Ensure callbacks see safetyNetCancelled === false at this point —
      // we treat the fire as authoritative shutdown intent.
      console.warn(`[ui] safety-net (${safetyNetMs}ms) reached — shutting down (D-025 backstop)`);
      try {
        opts.onSafetyNet?.();
      } catch {
        // best-effort observer
      }
      // Drain upgrade-detached sockets first — `server.close()` does not
      // track them and would otherwise wait on them indefinitely.
      drainUpgradeSockets();
      // Close every bound HTTP server (two-socket loopback mode has two).
      for (const server of httpServers) {
        try {
          server.close();
        } catch {
          // best-effort
        }
      }
      release();
    }, safetyNetMs);
  };

  const nudgeSafetyNet = (): void => {
    if (safetyNetCancelled || safetyNetMs <= 0) return;
    armSafetyNet();
  };

  // Expose the nudge to the HTTP handler so every /api/config request resets
  // the timer. Without this an actively-used UI disconnects at 12h — the
  // safety-net is meant to catch orphaned siblings, not healthy ones.
  apiConfigNudge = nudgeSafetyNet;

  armSafetyNet();

  return {
    httpServers,
    port: realPort,
    release,
    detachSafetyNet,
    nudgeSafetyNet,
    drainUpgradeSockets,
  };
}

// Plain static 404 for SPA-bundle / asset fall-throughs. Distinct from the
// RFC 9457 problem+json envelope (`emitProblem`), which is reserved for the
// `/api/*` surface: a missing `/assets/*.js` is a static miss, and emitting
// the API error envelope there sent a real debugging session chasing a phantom
// routing bug. Mirrors the asset-serve middleware's own fall-through 404
// (empty body + nosniff).
function notFoundStatic(res: ServerResponse): void {
  // Three-way guard mirrors `emitProblem` — a TCP RST can destroy the socket
  // before headers are sent (`headersSent` false but `destroyed` true).
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // `no-store`: a 404 is heuristically cacheable (RFC 9111 §4.2.2), and a
  // cached miss on a bundle URL would re-create the blank screen during the
  // mid-rebuild window this fix targets. Matches the old `emitProblem` path.
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 404;
  res.end();
}

/**
 * Result of port resolution. `fallbackToKernel` is true only when the port
 * came from `DEFAULT_UI_PORT` (i.e. no `--port` flag and no `PORT` env) —
 * operator-explicit ports never silently move on `EADDRINUSE`.
 */
interface ResolvedRequestedPort {
  port: number;
  fallbackToKernel: boolean;
}

function resolveRequestedPort(
  optsPort: string | undefined,
  envPort: string | undefined,
): ResolvedRequestedPort {
  if (optsPort !== undefined) {
    const parsed = Number.parseInt(optsPort, 10);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 65535) {
      throw new Error(`Invalid --port value '${optsPort}'`);
    }
    return { port: parsed, fallbackToKernel: false };
  }
  if (envPort !== undefined && envPort !== '') {
    const parsed = Number.parseInt(envPort, 10);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 65535) {
      throw new Error(`Invalid PORT env value '${envPort}'`);
    }
    return { port: parsed, fallbackToKernel: false };
  }
  // Default port `DEFAULT_UI_PORT` (39847) with bind-with-fallback to
  // kernel-allocation. Picked to be quirky and IANA-unassigned so the
  // common-case collision rate is ~zero; the bind layer falls back to
  // port 0 (kernel-allocated) when the default is busy, preserving the
  // multi-project bind guarantee against silent cross-family collisions.
  // MCP preview URLs dereference `ui.lock.port` so no client contract
  // breaks. Claude's `launch.json` uses a DIFFERENT port
  // (`LAUNCH_JSON_PORT` = 39848) as its probe target; the lock-collision
  // proxy in this same file bridges that port to whatever port the real
  // `ok ui` is bound on.
  return { port: DEFAULT_UI_PORT, fallbackToKernel: true };
}

/**
 * Decide what to do when another `ok ui` already holds `ui.lock`.
 *
 * - Same requested port as the lock holder → "already running"; caller
 *   logs and exits 0 (no proxy; duplicate attempt).
 * - Different requested port, lock port > 0 → reverse HTTP proxy on the
 *   requested port forwarding to the lock holder.
 * - Different requested port, lock port == 0 → poll the lock for up to
 *   `pollDeadlineMs` (default 2000); throw if still 0 at deadline.
 * - Lock disappears during resolution → throw so the caller can retry
 *   acquiring cleanly.
 *
 * No side effects beyond starting the proxy server on the "proxy" branch.
 * Tests verify each branch directly without driving Commander.
 */
type UiCollisionResult =
  | { mode: 'already-running'; port: number }
  | { mode: 'proxy'; handle: ProxyServerHandle; upstreamPort: number };

interface ResolveUiLockCollisionOptions {
  requestedPort: number;
  host: string;
  lockDir: string;
  /** Override for tests. Defaults to `readUiLock` from the server package. */
  readLock?: () =>
    | import('@inkeep/open-knowledge-server').UiLockMetadata
    | null
    | Promise<import('@inkeep/open-knowledge-server').UiLockMetadata | null>;
  pollIntervalMs?: number;
  pollDeadlineMs?: number;
}

export async function resolveUiLockCollision(
  opts: ResolveUiLockCollisionOptions,
): Promise<UiCollisionResult> {
  const readLock =
    opts.readLock ??
    (async () => {
      const { readUiLock } = await import('@inkeep/open-knowledge-server');
      return readUiLock(opts.lockDir);
    });

  const initial = await readLock();
  if (!initial) {
    throw new Error(
      'UI lock collision reported but the lock disappeared before handling — retry acquiring.',
    );
  }

  if (initial.port === opts.requestedPort && initial.port > 0) {
    return { mode: 'already-running', port: initial.port };
  }

  let upstreamPort = initial.port;
  if (upstreamPort === 0) {
    const deadline = Date.now() + (opts.pollDeadlineMs ?? 2000);
    const intervalMs = opts.pollIntervalMs ?? 100;
    while (Date.now() < deadline) {
      await new Promise<void>((done) => {
        setTimeout(done, intervalMs);
      });
      const lock = await readLock();
      if (lock && lock.port > 0) {
        upstreamPort = lock.port;
        break;
      }
    }
    if (upstreamPort === 0) {
      throw new Error('UI did not bind within 2s; run `ok clean`');
    }
    if (upstreamPort === opts.requestedPort) {
      return { mode: 'already-running', port: upstreamPort };
    }
  }

  const handle = await startProxyServer({
    listenPort: opts.requestedPort,
    host: opts.host,
    upstreamHost: 'localhost',
    upstreamPort,
  });
  return { mode: 'proxy', handle, upstreamPort };
}

export function uiCommand(getConfig: () => Config): Command {
  return new Command('ui')
    .description('Serve the OpenKnowledge React editor UI')
    .option(
      '-p, --port <port>',
      `UI port (default: $PORT env or ${DEFAULT_UI_PORT}, kernel-allocated fallback if busy)`,
    )
    .option(
      '-H, --host <host>',
      'UI host. Default: two-socket loopback bind (`[::1]` + `127.0.0.1`) so cross-family collisions fail loud. Pass an explicit host (e.g. `127.0.0.1`, `0.0.0.0`) to bind a single socket on that host.',
    )
    .action(async (opts: { port?: string; host?: string }) => {
      const { dim } = await import('../ui/colors.ts');
      const { UiLockCollisionError } = await import('@inkeep/open-knowledge-server');
      const { resolveLockDir } = await import('@inkeep/open-knowledge-server');
      const config = getConfig();
      // Undefined `host` triggers the default two-socket loopback mode in
      // startUiServer. Callers who pass `-H` get single-socket bind as-is.
      const host = opts.host;

      let resolved: ResolvedRequestedPort;
      try {
        resolved = resolveRequestedPort(opts.port, process.env.PORT);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      const requestedPort = resolved.port;

      try {
        const handle = await startUiServer({
          config,
          cwd: process.cwd(),
          port: requestedPort,
          fallbackToKernel: resolved.fallbackToKernel,
          host,
        });
        // Display a clickable URL in the log. Two-socket loopback mode
        // (host === undefined) and wildcard binds don't have a single
        // canonical host string, so default to `localhost` — it resolves
        // to whichever loopback family the browser prefers and both are
        // bound.
        const displayHost =
          host === undefined || host === '::' || host === '0.0.0.0' ? 'localhost' : host;
        console.log(`${dim('[ui]')} listening on http://${displayHost}:${handle.port}`);

        let shuttingDown = false;
        const shutdown = (signal: NodeJS.Signals) => {
          if (shuttingDown) return;
          shuttingDown = true;
          console.log(dim(`\n[ui] Shutting down (${signal})`));
          // Release the lock LAST, inside a finally, so a
          // mid-shutdown throw still removes the lockfile. Inverting this
          // (lock first, socket close second) re-introduces the stale-lock
          // + EADDRINUSE race the zero-ceremony design set out to eliminate.
          // Matches the shutdown pattern in `packages/server/src/server-factory.ts`.
          handle.detachSafetyNet();
          const finish = () => {
            try {
              handle.release();
            } finally {
              process.exit(process.exitCode ?? 0);
            }
          };
          // Drain upgrade-detached WebSocket sockets first — closeHttpServers
          // awaits `httpServer.close()` which does NOT track upgrade-detached
          // sockets, so a long-lived `/collab` WS would otherwise stall the
          // shutdown right up to the 2s hard-deadline.
          handle.drainUpgradeSockets();
          // Close every bound server (two in the default two-socket mode)
          // before releasing the lock. If any .close() throws synchronously
          // we still fall through to finish() via the catch.
          closeHttpServers(handle.httpServers).then(finish, finish);
          // Hard-deadline fallback — if close() hangs on an in-flight request,
          // we still release the lock and exit rather than stranding a stale
          // lockfile forever.
          setTimeout(finish, 2000).unref();
        };
        process.once('SIGINT', () => shutdown('SIGINT'));
        process.once('SIGTERM', () => shutdown('SIGTERM'));
        return;
      } catch (err) {
        if (!(err instanceof UiLockCollisionError)) throw err;

        // Lock anchor is the project root (cwd), not contentDir — see
        // server-factory.ts. The collision-recovery path must read the
        // lock from the same place the running UI server wrote it.
        const lockDir = resolveLockDir(process.cwd());
        // The proxy + collision code paths expect a concrete host string.
        // When the caller didn't pass `-H`, fall back to `localhost` — the
        // proxy only matters when a SECOND `ok ui` races against a live
        // lock, and that proxy's single-socket
        // loopback is acceptable (unlike the primary server, which does
        // two-socket for collision-fail-loud).
        const proxyHost = host ?? 'localhost';
        let result: UiCollisionResult;
        try {
          result = await resolveUiLockCollision({
            requestedPort,
            host: proxyHost,
            lockDir,
          });
        } catch (collisionErr) {
          console.error(
            collisionErr instanceof Error ? collisionErr.message : String(collisionErr),
          );
          process.exit(1);
        }

        if (result.mode === 'already-running') {
          console.log(`UI already running at http://${proxyHost}:${result.port}`);
          // Non-interactive callers (no TTY, or PORT env set) get a keepalive
          // instead of exit(0): Claude Code Desktop's preview pane spawns
          // `ok ui` as a subprocess with PORT set, treats subprocess exit
          // as "preview crashed", and tears down the pane. The keepalive
          // makes the subprocess stay attached to the already-running UI
          // until the pane sends SIGTERM. Interactive TTY users still get
          // a clean exit so they're not stuck staring at a hung command.
          if (isNonInteractiveContext(process)) {
            const idleResolve = new Promise<void>((resolve) => {
              const shutdown = (signal: NodeJS.Signals): void => {
                console.log(dim(`\n[ui-keepalive] Shutting down (${signal})`));
                resolve();
              };
              process.once('SIGINT', () => shutdown('SIGINT'));
              process.once('SIGTERM', () => shutdown('SIGTERM'));
            });
            await idleResolve;
            return;
          }
          process.exit(0);
        }

        console.log(
          `UI running at http://${proxyHost}:${result.upstreamPort}; acting as HTTP proxy on port ${result.handle.port}`,
        );

        let shuttingDown = false;
        const shutdown = (signal: NodeJS.Signals) => {
          if (shuttingDown) return;
          shuttingDown = true;
          console.log(dim(`\n[ui-proxy] Shutting down (${signal})`));
          result.handle.close().finally(() => process.exit(process.exitCode ?? 0));
          setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
        };
        process.once('SIGINT', () => shutdown('SIGINT'));
        process.once('SIGTERM', () => shutdown('SIGTERM'));
      }
    });
}

// Exported for tests.
export { resolveRequestedPort };

/**
 * "Non-interactive" gate for the `already-running` collision path. When the
 * caller has no TTY (e.g. spawned by a parent process) OR is invoked with a
 * `PORT` env (Claude Code Desktop's `.claude/launch.json` template sets
 * `PORT=39848` + `autoPort:true`), `process.exit(0)` is wrong — the preview
 * pane treats subprocess exit as "preview crashed" and tears down. Instead,
 * the action handler stays attached as a keepalive until SIGTERM.
 *
 * Interactive TTY callers still get a clean exit so they aren't stuck
 * staring at a hung command.
 *
 * Type-shaped against `NodeJS.Process` so tests can pass a minimal fake.
 */
export function isNonInteractiveContext(proc: Pick<NodeJS.Process, 'stdout' | 'env'>): boolean {
  const hasTty = proc.stdout.isTTY === true;
  const hasPortEnv = typeof proc.env.PORT === 'string' && proc.env.PORT !== '';
  return !hasTty || hasPortEnv;
}

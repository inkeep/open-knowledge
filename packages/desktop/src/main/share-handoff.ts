/**
 * First-run deferred-share handshake — the desktop half of the install-boundary
 * carry.
 *
 * On the app's true first launch, a receiver who downloaded via a share link
 * has a first-party `ok_pending_share` cookie in their browser. This module
 * binds a one-shot localhost listener, opens the default browser to
 * `https://openknowledge.ai/continue?port&nonce`, and the web `/continue` route
 * 302s the pending share token back to the listener. The redeemed token is
 * reconstructed into a `https://openknowledge.ai/d/<token>` universal-link URL
 * and fed through the SAME validated receive spine an Apple Event would use —
 * no new trust surface.
 *
 * Security: the listener binds 127.0.0.1 only and serves exactly one GET route.
 * The nonce is a per-launch CSPRNG secret, compared in constant time and
 * single-use (invalidated on the first request regardless of outcome), so a
 * local process racing the redemption cannot win. The redeemed value is an
 * untrusted public share URL; it is length-capped here and fully re-validated
 * by `parseShareUrl` downstream.
 *
 * The pure decision helpers (request classification) are exported and unit
 * tested; the Electron/Node glue is dependency-injected so the module loads in
 * bun:test without an Electron runtime.
 *
 * CROSS-TREE CONTRACT (mirror): the web half lives in
 * `docs/src/lib/deferred-share.ts`. Both must agree on the continue path, the
 * `port`/`nonce` query param names, the `/redeem` path, its `token`/`nonce`
 * params, and the `/continue/done` confirmation hop. Those names are duplicated
 * below with this drift note.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Mirror of `docs/src/lib/deferred-share.ts` — keep in lock-step. */
const PROD_BASE = 'https://openknowledge.ai';
const REDEEM_PATH = '/redeem';
const REDEEM_TOKEN_PARAM = 'token';
const REDEEM_NONCE_PARAM = 'nonce';

/**
 * Universal-link prefix the redeemed token is reconstructed onto. ALWAYS the
 * production host — this URL is fed back through `parseShareUrl`, whose host
 * allowlist only accepts `openknowledge.ai`. It is internal routing, never a
 * browser URL, so the dev base override below must NOT touch it.
 */
const SHARE_LINK_PREFIX = `${PROD_BASE}/d/`;

/**
 * Resolve the origin of the browser-facing continue pages. Honors
 * `OK_CONTINUE_URL_BASE` for local/dev testing (e.g. `http://localhost:3010`
 * against `cd docs && bun run dev`), but ONLY when it points at loopback — so
 * the env can never redirect a first-run handshake to an off-box host. Any
 * other value (including a non-loopback https origin) falls back to production.
 */
export function resolveContinueBase(env: Record<string, string | undefined> = process.env): string {
  const override = env.OK_CONTINUE_URL_BASE?.trim();
  if (override && isLoopbackHttpUrl(override)) return override.replace(/\/+$/, '');
  return PROD_BASE;
}

function isLoopbackHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/** Upper bound on the redeemed token — matches the web `MAX_TOKEN_LENGTH`. */
const MAX_TOKEN_LENGTH = 4096;
/** base64url alphabet — the token is `encodeShareUrl` output. */
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

/** Nonce entropy: 16 bytes = 128 bits, hex-encoded. */
const NONCE_BYTES = 16;

/** How long the listener waits for a redemption before closing silently. */
const DEFAULT_LISTENER_LIFETIME_MS = 3 * 60 * 1000;

export function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString('hex');
}

/** Constant-time nonce comparison; false on any length/shape mismatch. */
export function nonceMatches(expected: string, candidate: string | null): boolean {
  if (candidate === null) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isValidToken(token: string | null): token is string {
  return (
    token !== null && token.length > 0 && token.length <= MAX_TOKEN_LENGTH && TOKEN_RE.test(token)
  );
}

/** The URL the app opens in the default browser to start the handshake. */
export function buildContinueUrl(
  port: number,
  nonce: string,
  base: string = resolveContinueBase(),
): string {
  const params = new URLSearchParams({ port: String(port), nonce });
  return `${base}/continue?${params.toString()}`;
}

/**
 * Classify an inbound listener request. The expected nonce is consumed
 * (single-use) by the caller before this returns a non-`ignore` verdict; here
 * we only decide what the request means.
 *
 * - `redeem` — valid nonce + token; carries the reconstructed share URL to
 *   route and the confirmation-page location to send the browser to.
 * - `invalid` — the request hit the redeem path but failed validation; the
 *   browser still gets a friendly failure page, and the nonce is burned.
 * - `ignore` — not our route (favicon, probes); no nonce consumed.
 */
export type RedeemDecision =
  | { kind: 'redeem'; shareUrl: string; doneLocation: string }
  | { kind: 'invalid' }
  | { kind: 'ignore' };

export function classifyRedeemRequest(input: {
  pathname: string;
  token: string | null;
  nonce: string | null;
  expectedNonce: string;
  /** Origin of the confirmation page. Defaults to production. */
  continueBase?: string;
}): RedeemDecision {
  if (input.pathname !== REDEEM_PATH) return { kind: 'ignore' };
  if (!nonceMatches(input.expectedNonce, input.nonce)) return { kind: 'invalid' };
  if (!isValidToken(input.token)) return { kind: 'invalid' };
  return {
    kind: 'redeem',
    shareUrl: `${SHARE_LINK_PREFIX}${input.token}`,
    doneLocation: `${input.continueBase ?? PROD_BASE}/continue/done`,
  };
}

/** Parse a listener request URL into the fields `classifyRedeemRequest` needs. */
export function parseRedeemRequestUrl(
  requestUrl: string,
  base: string,
): { pathname: string; token: string | null; nonce: string | null } {
  const url = new URL(requestUrl, base);
  return {
    pathname: url.pathname,
    token: url.searchParams.get(REDEEM_TOKEN_PARAM),
    nonce: url.searchParams.get(REDEEM_NONCE_PARAM),
  };
}

// ─── Electron/Node glue (dependency-injected) ────────────────────────────────

/** Minimal HTTP server surface — the subset of `node:http.Server` we touch. */
export interface HandoffHttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}
export interface HandoffHttpRequest {
  url?: string;
}
export interface HandoffHttpServer {
  listen(port: number, host: string, cb: () => void): void;
  on(event: 'error', cb: (err: NodeJS.ErrnoException) => void): void;
  address(): { port: number } | string | null;
  close(): void;
}

export interface FirstRunHandshakeDeps {
  /** True only on a genuine first launch (absent persisted app state). */
  isFirstRun: () => boolean;
  /** Create an HTTP server bound to the given request handler. */
  createServer: (
    handler: (req: HandoffHttpRequest, res: HandoffHttpResponse) => void,
  ) => HandoffHttpServer;
  /** Open a URL in the default browser. */
  openExternal: (url: string) => void;
  /** Feed a reconstructed share URL into the validated receive spine. */
  routeShareUrl: (url: string) => void;
  /** Emit a structured first-run handoff outcome span. */
  recordOutcome: (outcome: HandoffOutcome) => void;
  /** Override the continue-page origin. Defaults to `resolveContinueBase()`. */
  continueBase?: string;
  /** Test seams. */
  generateNonce?: () => string;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  listenerLifetimeMs?: number;
  log?: { warn(obj: object, msg: string): void; info?(obj: object, msg: string): void };
}

export type HandoffOutcome = 'redeemed' | 'invalid' | 'timeout' | 'skipped' | 'bind-failed';

/**
 * Arm the first-run handshake. No-op (records `skipped`) when this is not a
 * true first launch. Never throws and never blocks boot — every failure path
 * degrades to the splash/re-click recovery.
 */
export function startFirstRunHandshake(deps: FirstRunHandshakeDeps): void {
  if (!deps.isFirstRun()) {
    deps.recordOutcome('skipped');
    return;
  }

  const mkNonce = deps.generateNonce ?? generateNonce;
  const schedule = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const cancel = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const lifetime = deps.listenerLifetimeMs ?? DEFAULT_LISTENER_LIFETIME_MS;
  // Resolved once so the browser-open and the redeem confirmation hop share the
  // same origin (production, or a loopback dev override).
  const continueBase = deps.continueBase ?? resolveContinueBase();

  const nonce = mkNonce();
  let settled = false;
  let timer: unknown = null;

  const server = deps.createServer((req, res) => {
    // Single-use: the first request through the listener consumes it, whatever
    // the verdict, so a replayed/failed attempt can't be retried for free.
    if (settled) {
      res.statusCode = 410;
      res.end('Gone');
      return;
    }

    let decision: RedeemDecision;
    try {
      const parsed = parseRedeemRequestUrl(req.url ?? '/', 'http://127.0.0.1');
      decision = classifyRedeemRequest({ ...parsed, expectedNonce: nonce, continueBase });
    } catch {
      decision = { kind: 'invalid' };
    }

    if (decision.kind === 'ignore') {
      // Not the redeem route (favicon, probe). Don't burn the nonce.
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    settled = true;
    if (timer !== null) cancel(timer);

    if (decision.kind === 'redeem') {
      res.statusCode = 302;
      res.setHeader('Location', decision.doneLocation);
      res.end();
      deps.log?.info?.({}, '[receive] source=deferred action=redeemed');
      deps.recordOutcome('redeemed');
      // Route AFTER responding so the browser confirmation isn't blocked on
      // downstream window/clone work.
      try {
        deps.routeShareUrl(decision.shareUrl);
      } catch (err) {
        deps.log?.warn(
          { err: err instanceof Error ? err.message : String(err) },
          '[receive] source=deferred routeShareUrl threw',
        );
      }
    } else {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(
        'This share handoff could not be completed. Open the original share link again to try once more.',
      );
      deps.log?.warn({}, '[receive] source=deferred action=invalid');
      deps.recordOutcome('invalid');
    }
    server.close();
  });

  server.on('error', (err) => {
    // Any listen failure degrades silently — the user still has the splash
    // re-click recovery. Binding to port 0 makes EADDRINUSE effectively
    // impossible, so this is a defense-in-depth path.
    deps.log?.warn({ code: err.code }, '[receive] source=deferred listener error');
    if (!settled) {
      settled = true;
      if (timer !== null) cancel(timer);
      deps.recordOutcome('bind-failed');
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    if (addr === null || typeof addr === 'string') {
      settled = true;
      deps.recordOutcome('bind-failed');
      server.close();
      return;
    }
    deps.openExternal(buildContinueUrl(addr.port, nonce, continueBase));
    timer = schedule(() => {
      if (settled) return;
      settled = true;
      deps.log?.info?.({}, '[receive] source=deferred action=timeout');
      deps.recordOutcome('timeout');
      server.close();
    }, lifetime);
  });
}

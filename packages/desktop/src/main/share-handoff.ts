
import { randomBytes, timingSafeEqual } from 'node:crypto';

const PROD_BASE = 'https://openknowledge.ai';
const REDEEM_PATH = '/redeem';
const REDEEM_TOKEN_PARAM = 'token';
const REDEEM_NONCE_PARAM = 'nonce';

const SHARE_LINK_PREFIX = `${PROD_BASE}/d/`;

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

const MAX_TOKEN_LENGTH = 4096;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

const NONCE_BYTES = 16;

const DEFAULT_LISTENER_LIFETIME_MS = 3 * 60 * 1000;

export function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString('hex');
}

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

export function buildContinueUrl(
  port: number,
  nonce: string,
  base: string = resolveContinueBase(),
): string {
  const params = new URLSearchParams({ port: String(port), nonce });
  return `${base}/continue?${params.toString()}`;
}

export type RedeemDecision =
  | { kind: 'redeem'; shareUrl: string; doneLocation: string }
  | { kind: 'invalid' }
  | { kind: 'ignore' };

export function classifyRedeemRequest(input: {
  pathname: string;
  token: string | null;
  nonce: string | null;
  expectedNonce: string;
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
  isFirstRun: () => boolean;
  createServer: (
    handler: (req: HandoffHttpRequest, res: HandoffHttpResponse) => void,
  ) => HandoffHttpServer;
  openExternal: (url: string) => void;
  routeShareUrl: (url: string) => void;
  recordOutcome: (outcome: HandoffOutcome) => void;
  continueBase?: string;
  generateNonce?: () => string;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  listenerLifetimeMs?: number;
  log?: { warn(obj: object, msg: string): void; info?(obj: object, msg: string): void };
}

export type HandoffOutcome = 'redeemed' | 'invalid' | 'timeout' | 'skipped' | 'bind-failed';

export function startFirstRunHandshake(deps: FirstRunHandshakeDeps): void {
  if (!deps.isFirstRun()) {
    deps.recordOutcome('skipped');
    return;
  }

  const mkNonce = deps.generateNonce ?? generateNonce;
  const schedule = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const cancel = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const lifetime = deps.listenerLifetimeMs ?? DEFAULT_LISTENER_LIFETIME_MS;
  const continueBase = deps.continueBase ?? resolveContinueBase();

  const nonce = mkNonce();
  let settled = false;
  let timer: unknown = null;

  const server = deps.createServer((req, res) => {
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

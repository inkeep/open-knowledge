
export const PENDING_SHARE_COOKIE = 'ok_pending_share';

export const PENDING_SHARE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export const PORT_PARAM = 'port';
export const NONCE_PARAM = 'nonce';

const REDEEM_TOKEN_PARAM = 'token';
const REDEEM_NONCE_PARAM = 'nonce';

const REDEEM_PATH = '/redeem';

const MAX_TOKEN_LENGTH = 4096;

const MIN_PORT = 1;
const MAX_PORT = 65535;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const NONCE_RE = /^[a-f0-9]{16,128}$/;

export interface PendingShareCookieInit {
  name: typeof PENDING_SHARE_COOKIE;
  value: string;
  httpOnly: true;
  secure: true;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

export function buildPendingShareCookie(token: string): PendingShareCookieInit {
  return {
    name: PENDING_SHARE_COOKIE,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: PENDING_SHARE_MAX_AGE_SECONDS,
  };
}

function isValidToken(token: string): boolean {
  return token.length > 0 && token.length <= MAX_TOKEN_LENGTH && BASE64URL_RE.test(token);
}

function isValidPort(port: string | null): port is string {
  if (port === null || !/^\d+$/.test(port)) return false;
  const n = Number(port);
  return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;
}

function isValidNonce(nonce: string | null): nonce is string {
  return nonce !== null && NONCE_RE.test(nonce);
}

export type ContinueDecision =
  | { kind: 'redeem'; location: string }
  | { kind: 'welcome'; clearCookie: boolean };

export function decideContinue(input: {
  cookieToken: string | undefined | null;
  port: string | null;
  nonce: string | null;
}): ContinueDecision {
  const cookieToken = input.cookieToken ?? '';

  if (!isValidPort(input.port) || !isValidNonce(input.nonce)) {
    return { kind: 'welcome', clearCookie: false };
  }

  if (!isValidToken(cookieToken)) {
    return { kind: 'welcome', clearCookie: cookieToken.length > 0 };
  }

  const params = new URLSearchParams({
    [REDEEM_TOKEN_PARAM]: cookieToken,
    [REDEEM_NONCE_PARAM]: input.nonce,
  });
  return {
    kind: 'redeem',
    location: `http://127.0.0.1:${input.port}${REDEEM_PATH}?${params.toString()}`,
  };
}

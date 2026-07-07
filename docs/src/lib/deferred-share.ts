/**
 * Deferred-share carry: the web half of the install-boundary handoff.
 *
 * A receiver who clicks a share link without OpenKnowledge installed
 * downloads the DMG through `/d/<encoded>/download`, which drops a first-party
 * cookie holding the `<encoded>` share token and 302s to the unchanged GitHub
 * asset. On the app's true first launch it opens a localhost listener and
 * navigates the default browser to `/continue?port&nonce`; this module's
 * `decideContinue` redirects the pending token to that listener. A final
 * `/continue/done` hop clears the cookie once redemption is confirmed.
 *
 * The pure decision functions live here (no Next.js imports) so the route
 * handlers stay thin and the branching is unit-testable. The state carried is
 * the public share token already encoded in the `/d/<encoded>` URL — nothing
 * new and nothing per-user beyond what the splash page already exposes.
 *
 * CROSS-TREE CONTRACT (mirror): the desktop first-run handshake
 * (`packages/desktop/src/main/share-handoff.ts`) is the other half. It opens
 * `CONTINUE_PATH` with `PORT_PARAM`/`NONCE_PARAM`, and serves the
 * `REDEEM_TOKEN_PARAM`/`REDEEM_NONCE_PARAM` redeem request this module
 * redirects to. Both halves must agree on these names; the desktop module
 * carries the matching constants with a drift note.
 */

/** Name of the first-party cookie that carries the pending share token. */
export const PENDING_SHARE_COOKIE = 'ok_pending_share';

/** Lifetime of the pairing cookie — bounds the download→install gap. */
export const PENDING_SHARE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Query params the desktop appends when it opens the continue page. */
export const PORT_PARAM = 'port';
export const NONCE_PARAM = 'nonce';

/** Query params on the loopback redeem request this page redirects to. */
const REDEEM_TOKEN_PARAM = 'token';
const REDEEM_NONCE_PARAM = 'nonce';

/** Single GET route the desktop listener serves. */
const REDEEM_PATH = '/redeem';

/**
 * Upper bound on the cookie token we'll act on. Real `/d/<encoded>` tokens are
 * a few hundred base64url chars; anything larger is hostile or corrupt and is
 * dropped before it reaches the redirect builder.
 */
const MAX_TOKEN_LENGTH = 4096;

/** Loopback ephemeral port range (OS-assigned). */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/** base64url alphabet — the share token is `encodeShareUrl` output. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
/** The nonce is hex from the desktop's `crypto.randomBytes(16).toString('hex')`. */
const NONCE_RE = /^[a-f0-9]{16,128}$/;

/** Cookie attributes for the pairing cookie — set only by the download route. */
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

/**
 * Decision for `GET /continue`. Inputs are the pending-share cookie value and
 * the `port`/`nonce` query params; outputs are either a redirect to the
 * desktop's loopback listener (redemption hop) or "render the welcome page".
 *
 * Redirect ONLY when all three are present and well-formed. A direct visit (no
 * port/nonce) or a missing/malformed cookie falls to the welcome page; a
 * malformed cookie additionally signals the caller to clear it. The cookie is
 * NEVER cleared on a redirect — clearing is the `/continue/done` hop's job
 * (single-use = consumed at confirmed redemption, not at the 302), so an
 * interrupted handshake leaves the pairing intact for a later retry.
 *
 * The redirect host is hardcoded loopback; only the numeric port is taken from
 * the (untrusted) query. The token is the victim's public share URL and the
 * nonce must match the app's per-launch secret, so a crafted port cannot
 * exfiltrate anything of value — it can at most reach a listener on the user's
 * own machine, the same threat surface the desktop nonce already gates.
 */
export type ContinueDecision =
  | { kind: 'redeem'; location: string }
  | { kind: 'welcome'; clearCookie: boolean };

export function decideContinue(input: {
  cookieToken: string | undefined | null;
  port: string | null;
  nonce: string | null;
}): ContinueDecision {
  const cookieToken = input.cookieToken ?? '';

  // No handshake params → this is a direct visit (or the desktop opened it with
  // no pending pairing). Render the welcome page; keep any valid cookie so a
  // later real handshake can still redeem it.
  if (!isValidPort(input.port) || !isValidNonce(input.nonce)) {
    return { kind: 'welcome', clearCookie: false };
  }

  // Handshake params are present but there's no usable cookie. A malformed
  // (present-but-invalid) cookie is cleared; a simply-absent cookie is not.
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

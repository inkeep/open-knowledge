/**
 * Classify a failed GitHub API auth check so a TLS/certificate-trust failure
 * isn't reported as an invalid token.
 *
 * A GitHub Enterprise Server on a self-signed or internal-CA certificate fails
 * the TLS handshake in Node/undici (surfaced via `err.cause.code`, e.g.
 * `DEPTH_ZERO_SELF_SIGNED_CERT`) even when the token is perfectly valid — `git`
 * accepts the same host via the system trust store. The app launches Node with
 * `--use-system-ca` so it trusts that same store; this classifier keeps the
 * message honest for the cases where the CA still isn't trusted (a bare terminal
 * `ok`, or a CA that was never added to the system store).
 */
type AuthFailureKind = 'token' | 'tls' | 'network';

export interface AuthFailure {
  readonly kind: AuthFailureKind;
  readonly message: string;
}

function errorCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  if (typeof cause?.code === 'string') return cause.code;
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Node/OpenSSL error-code fragments that mean "the TLS certificate chain
 * couldn't be trusted" — covers self-signed certs (DEPTH_ZERO_SELF_SIGNED_CERT,
 * SELF_SIGNED_CERT_IN_CHAIN), untrusted internal CAs (UNABLE_TO_VERIFY_LEAF_
 * SIGNATURE, UNABLE_TO_GET_ISSUER_CERT), and expiry/altname (CERT_HAS_EXPIRED,
 * ERR_TLS_CERT_ALTNAME_INVALID). Substring match so the family stays covered.
 */
const TLS_CODE_FRAGMENTS = ['CERT', 'SELF_SIGNED', 'SIGNATURE', 'ISSUER'];

export function describeAuthFailure(err: unknown, host: string): AuthFailure {
  const code = errorCode(err);
  if (code && TLS_CODE_FRAGMENTS.some((f) => code.includes(f))) {
    return {
      kind: 'tls',
      message:
        `Could not verify the TLS certificate for ${host}. If this is a GitHub ` +
        `Enterprise Server with a self-signed or internal-CA certificate, add its ` +
        `CA to your system trust store (macOS Keychain).`,
    };
  }
  const status = (err as { status?: unknown } | undefined)?.status;
  if (status === 401) return { kind: 'token', message: `Token invalid for ${host}` };
  if (status === 403) {
    // The token authenticated but the request was refused — wrong scopes, or an
    // organization SSO policy the token isn't authorized for. Calling this
    // "invalid" sends the user to regenerate a token that would fail the same
    // way; name the actual resolution path instead.
    return {
      kind: 'token',
      message:
        `Token rejected by ${host} — check that it has the repo and read:user ` +
        `scopes, and that it is authorized for SSO if the organization requires it`,
    };
  }
  if (code) return { kind: 'network', message: `Could not reach ${host} (${code})` };
  return { kind: 'token', message: `Authentication failed for ${host}` };
}

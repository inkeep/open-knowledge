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

const TLS_CODE_FRAGMENTS = ['CERT', 'SELF_SIGNED', 'SIGNATURE', 'ISSUER'];

export function describeAuthFailure(err: unknown, host: string): AuthFailure {
  const code = errorCode(err);
  if (code && TLS_CODE_FRAGMENTS.some((f) => code.includes(f))) {
    return {
      kind: 'tls',
      message:
        `Could not verify the TLS certificate for ${host}. If this is a GitHub ` +
        `Enterprise Server with a self-signed or internal-CA certificate, add its ` +
        `CA to your system trust store (macOS Keychain, Windows certificate store, ` +
        `or your distro's ca-certificates).`,
    };
  }
  const status = (err as { status?: unknown } | undefined)?.status;
  if (status === 401) return { kind: 'token', message: `Token invalid for ${host}` };
  if (status === 403) {
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

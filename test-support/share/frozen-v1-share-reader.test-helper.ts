export type FrozenV1TokenOutcome =
  | { readonly kind: 'ok'; readonly version: 1; readonly sharedUrl: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unsupported-version'; readonly version: number };

export type FrozenV1CustomOutcome = 'invalid' | 'ok-v1-url';

/**
 * Release-baseline v1 decoder copied before v2 exists. It deliberately owns
 * its base64url and UTF-8 paths and must never import the production codec.
 */
export function frozenV1DecodeShareToken(encoded: string): FrozenV1TokenOutcome {
  const cleaned = encoded.split(/[?#]/)[0];
  if (cleaned.length === 0) return { kind: 'invalid' };

  let bytes: Uint8Array;
  try {
    bytes = frozenBase64UrlDecode(cleaned);
  } catch {
    return { kind: 'invalid' };
  }
  if (bytes.length === 0) return { kind: 'invalid' };

  const version = bytes[0];
  if (version !== 0x01) return { kind: 'unsupported-version', version };

  try {
    const sharedUrl = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(1));
    return { kind: 'ok', version: 1, sharedUrl };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * Release-baseline custom-scheme routing ignores unknown query parameters and
 * reads only the historical url field. Token-only input is therefore invalid.
 */
export function frozenV1CustomSchemeOutcome(input: string): FrozenV1CustomOutcome {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return 'invalid';
  }
  if (parsed.protocol !== 'openknowledge:' || parsed.hostname !== 'share') return 'invalid';

  const sharedUrl = parsed.searchParams.get('url');
  if (!sharedUrl || sharedUrl.length > 4096 || sharedUrl.includes('\0')) return 'invalid';

  let source: URL;
  try {
    source = new URL(sharedUrl);
  } catch {
    return 'invalid';
  }
  if (source.protocol !== 'https:' || source.username || source.password) return 'invalid';

  const segments = source.pathname.split('/').filter(Boolean);
  const kindIndex = segments.findIndex((segment) => segment === 'blob' || segment === 'tree');
  if (kindIndex !== 2 || segments[kindIndex + 1] === undefined) return 'invalid';
  if (segments[kindIndex] === 'blob' && segments[kindIndex + 2] === undefined) return 'invalid';
  return 'ok-v1-url';
}

function frozenBase64UrlDecode(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    throw new Error('non-base64url input');
  }
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

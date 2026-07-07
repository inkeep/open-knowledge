/**
 * Share URL codec for the `https://openknowledge.ai/d/<base64url>` link form.
 *
 * Payload shape (by contract, 1-way once shipped):
 *   v1 = [0x01] || utf-8 bytes of the github blob URL
 *
 * Future versions reuse the same `/d/` path prefix by bumping the leading
 * byte; substrate changes (cloud-native shares, project-level shares) get
 * new path prefixes (`/s/`, `/p/`).
 *
 * Core is browser+Node compatible — no `node:` imports, no `Buffer`. Uses
 * `TextEncoder`/`TextDecoder` and `btoa`/`atob` which exist in both runtimes
 * (Node 16+, every modern browser, Bun).
 */

const SHARE_URL_VERSION_V1 = 0x01;

export interface DecodedShare {
  version: number;
  sharedUrl: string;
}

/**
 * Thrown when `decodeShareUrl` finds a version byte the current build does
 * not understand. Carries the observed numeric byte so the UI layer can
 * render a meaningful "Update OpenKnowledge" toast.
 */
export class UnsupportedShareVersionError extends Error {
  readonly version: number;
  constructor(version: number) {
    super(`Unsupported share URL version: 0x${version.toString(16).padStart(2, '0')}`);
    this.name = 'UnsupportedShareVersionError';
    this.version = version;
  }
}

/**
 * Thrown when the payload is not a well-formed v1 share URL — undecodable
 * base64url, empty, or non-UTF-8 body bytes.
 */
export class InvalidShareUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidShareUrlError';
  }
}

/**
 * Encode a GitHub blob URL into the v1 base64url share payload.
 *
 *   encodeShareUrl('https://github.com/a/b/blob/main/c.md')
 *   // → 'AWh0dHBzOi8vZ2l0aHViLmNvbS9hL2IvYmxvYi9tYWluL2MubWQ'
 */
export function encodeShareUrl(sharedUrl: string): string {
  const blobBytes = new TextEncoder().encode(sharedUrl);
  const bytes = new Uint8Array(1 + blobBytes.length);
  bytes[0] = SHARE_URL_VERSION_V1;
  bytes.set(blobBytes, 1);
  return uint8ArrayToBase64Url(bytes);
}

/**
 * Decode a base64url payload back into its `{ version, sharedUrl }`. Tolerates
 * an appended `?query` and/or `#fragment` (extensibility by contract) by
 * trimming them before base64url-decoding the body.
 *
 * Throws `UnsupportedShareVersionError` when the leading byte is not 0x01;
 * throws `InvalidShareUrlError` for empty, malformed base64url, or non-UTF-8
 * bodies.
 */
export function decodeShareUrl(encoded: string): DecodedShare {
  const cleaned = encoded.split(/[?#]/)[0];
  if (cleaned.length === 0) {
    throw new InvalidShareUrlError('Share payload is empty');
  }

  let bytes: Uint8Array;
  try {
    bytes = base64UrlToUint8Array(cleaned);
  } catch {
    throw new InvalidShareUrlError('Share payload is not valid base64url');
  }

  if (bytes.length === 0) {
    throw new InvalidShareUrlError('Share payload is empty');
  }

  const version = bytes[0];
  if (version !== SHARE_URL_VERSION_V1) {
    throw new UnsupportedShareVersionError(version);
  }

  // `fatal: true` makes TextDecoder throw on invalid UTF-8 instead of
  // silently substituting U+FFFD — the contract here is "round-trips back to
  // the exact same string or signals InvalidShareUrlError."
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let sharedUrl: string;
  try {
    sharedUrl = decoder.decode(bytes.subarray(1));
  } catch {
    throw new InvalidShareUrlError('Share payload body is not valid UTF-8');
  }

  return { version, sharedUrl };
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binaryString = '';
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binaryString);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToUint8Array(input: string): Uint8Array {
  // Reject any character outside the base64url alphabet up-front; `atob` is
  // surprisingly lenient on some platforms (e.g. it silently ignores some
  // non-alphabet bytes) and we want a deterministic InvalidShareUrlError.
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    throw new Error('Input contains non-base64url characters');
  }
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binaryString = atob(padded);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

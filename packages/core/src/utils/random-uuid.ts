/**
 * Cross-context `crypto.randomUUID()`.
 *
 * `crypto.randomUUID()` is a secure-context-only API in browsers: available on
 * HTTPS and on `localhost` / `127.0.0.1`, but ABSENT (`crypto.randomUUID is not
 * a function`) on a plain-HTTP non-localhost origin — a tailnet IP, a LAN IP, or
 * any direct-IP `http://` access. An exposed Open Knowledge server serves
 * exactly those origins, so a bare `crypto.randomUUID()` at module load throws
 * before React mounts and the page renders blank.
 *
 * `crypto.getRandomValues()` is NOT secure-context-gated, so we synthesize an
 * RFC 4122 version-4 UUID from it whenever `randomUUID` is unavailable. Node and
 * secure browser contexts keep taking the native path.
 */

const BYTE_TO_HEX: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  (i + 0x100).toString(16).slice(1),
);

export function randomUUID(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    // Last resort (no Web Crypto at all) — not cryptographically strong, but it
    // keeps identity generation from throwing. Unreachable in the browser + Node
    // targets we ship; present only so this function is total.
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  // RFC 4122 §4.4: version 4 in the high nibble of byte 6, variant 10xx in byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const h = BYTE_TO_HEX;
  return (
    `${h[bytes[0]]}${h[bytes[1]]}${h[bytes[2]]}${h[bytes[3]]}-` +
    `${h[bytes[4]]}${h[bytes[5]]}-` +
    `${h[bytes[6]]}${h[bytes[7]]}-` +
    `${h[bytes[8]]}${h[bytes[9]]}-` +
    `${h[bytes[10]]}${h[bytes[11]]}${h[bytes[12]]}${h[bytes[13]]}${h[bytes[14]]}${h[bytes[15]]}`
  );
}

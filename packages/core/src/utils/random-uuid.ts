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
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

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

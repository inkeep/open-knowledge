/**
 * Magic-byte buffers for upload e2e tests. Mirror the fixtures used by the
 * unit-tier `handleUploadAsset` tests in `packages/server/src/api-extension.test.ts`
 * (which exercise the unified `/api/upload` endpoint). Extracted here so the
 * e2e suite exercises the same byte sequences the server's
 * `fileTypeFromBuffer` dispatcher accepts — if `file-type` widens or narrows
 * its detection ranges, both surfaces fail the same way.
 *
 * The optional `salt` parameter appends salt bytes AFTER the format-defining
 * magic bytes, producing a buffer that still type-sniffs as the intended
 * format but has a distinct sha256. Required because HEAD's `/api/upload`
 * pipeline runs same-dir sha256 dedup — two byte-identical payloads collapse
 * to one stored file, which masks the "second upload replaces src" assertion
 * with a no-op rename. Pass distinct salts when a test needs distinct uploads.
 */

/** Minimal valid PNG (1×1 transparent pixel). `file-type` detects as image/png. */
export function createPngBuffer(salt?: string): Buffer {
  const base = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRElEQrkJggg==',
    'base64',
  );
  return salt === undefined ? base : Buffer.concat([base, Buffer.from(salt, 'utf8')]);
}

/** Minimal valid MP4 — a 24-byte `ftyp` box. `file-type` detects as video/mp4. */
export function createMp4Buffer(salt?: string): Buffer {
  const base = Buffer.from([
    0x00,
    0x00,
    0x00,
    0x18, // box size = 24
    0x66,
    0x74,
    0x79,
    0x70, // 'ftyp'
    0x6d,
    0x70,
    0x34,
    0x32, // major brand = 'mp42'
    0x00,
    0x00,
    0x00,
    0x00, // minor version
    0x6d,
    0x70,
    0x34,
    0x32, // compat brand = 'mp42'
    0x69,
    0x73,
    0x6f,
    0x6d, // compat brand = 'isom'
  ]);
  return salt === undefined ? base : Buffer.concat([base, Buffer.from(salt, 'utf8')]);
}

/** ID3v2 header + MPEG-1 Layer III sync frame. `file-type` detects as audio/mpeg. */
export function createMp3Buffer(salt?: string): Buffer {
  const base = Buffer.from([
    0x49,
    0x44,
    0x33, // 'ID3'
    0x04,
    0x00, // ID3v2.4
    0x00, // flags
    0x00,
    0x00,
    0x00,
    0x00, // sync-safe size 0 — no ID3 frames
    0xff,
    0xfb, // MPEG-1 Layer III sync
    0x90,
    0x44, // 128 kbps, 44.1 kHz, stereo
    ...new Array(28).fill(0x00),
  ]);
  return salt === undefined ? base : Buffer.concat([base, Buffer.from(salt, 'utf8')]);
}

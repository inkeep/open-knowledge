/**
 * `formatFileSize` — pinning the byte→human-string contract.
 *
 * The function is consumed by two production hot paths: the upload
 * pipeline (drop-time, `uploadAndInsert` → stamps `formatFileSize(file.size)`
 * on the wikiLinkEmbed PM node) AND the server-side parser
 * (`markdown/index.ts:wikiLinkEmbed` handler → `formatFileSize(resolveSize(...))`
 * for File-row size persistence across reloads). A regression in any of
 * the unit-boundary, `.0`-trim, or NaN/Infinity branches would produce
 * incorrect or empty size strings in every File attachment row.
 *
 * Coverage targets each branch of the implementation explicitly:
 *   - guard: NaN / Infinity / negative → `''`
 *   - sub-KiB: bytes < 1024 → `'N B'`
 *   - unit selection: 1024 → KiB; 1024² → MiB; 1024³ → GiB; 1024⁴ → TiB
 *   - precision + trim: 1.5 KiB stays "1.5 KiB"; 1.0 KiB trims to "1 KiB"
 *   - real-world inputs: a `.pdf` of 909_312 bytes renders "888 KiB"
 *     (matches what the showcase doc displays for sample-local-pdf.pdf)
 */

import { describe, expect, test } from 'bun:test';
import { formatFileSize } from './file-size.ts';

describe('formatFileSize', () => {
  test.each([
    // Guards — non-finite or negative inputs produce empty string so the
    // renderer's "omit size span" fallback applies. Renderer never sees a
    // garbage value like "NaN B".
    [NaN, ''],
    [Infinity, ''],
    [-Infinity, ''],
    [-1, ''],
    [-1024, ''],

    // Sub-KiB — emit raw bytes with the `B` suffix. No fractional precision
    // (1023 B is more useful than "1.0 KiB" for a 1023-byte file).
    [0, '0 B'],
    [1, '1 B'],
    [512, '512 B'],
    [1023, '1023 B'],

    // Unit boundaries — exactly 1024 promotes to the next unit.
    [1024, '1 KiB'],
    [1024 ** 2, '1 MiB'],
    [1024 ** 3, '1 GiB'],
    [1024 ** 4, '1 TiB'],

    // Beyond TiB — clamps at TiB rather than introducing PiB.
    [1024 ** 5, '1024 TiB'],

    // Precision + `.0` trim — whole-unit values trim trailing `.0` so
    // `320 KiB` doesn't render as `320.0 KiB` (Notion convention).
    [1024 * 320, '320 KiB'],
    [1024 * 1.5, '1.5 KiB'],
    [1024 * 1.25, '1.3 KiB'], // toFixed(1) rounds 1.25 → 1.3 (round-half-away-from-zero)

    // Real-world references — the showcase pins these for visual parity
    // with what authors see in Notion / GitHub for the same file sizes.
    [909_312, '888 KiB'],
    [1_258_291, '1.2 MiB'],
    [48_234_567, '46 MiB'],
  ])('formatFileSize(%p) → %p', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });
});

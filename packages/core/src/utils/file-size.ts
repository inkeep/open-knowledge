/**
 * Format a byte count as a human-readable size string using KiB / MiB
 * / GiB (binary units, matching Notion / GitHub / Obsidian
 * conventions). Returns the smallest unit that keeps the value under
 * 1024 with one decimal of precision; whole-unit values trim a
 * trailing `.0` so common round sizes render as "320 KiB" rather than
 * "320.0 KiB".
 *
 *   formatFileSize(512)        → "512 B"
 *   formatFileSize(909_312)    → "888 KiB"
 *   formatFileSize(1_258_291)  → "1.2 MiB"
 *   formatFileSize(0)          → "0 B"
 *   formatFileSize(NaN)        → ""
 *
 * Pure — reused at upload time
 * (`uploadAndInsert`'s drop-time stamp) AND parse time (server-side
 * `resolveSize` callback in `markdown/index.ts`).
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  const formatted = value.toFixed(1).replace(/\.0$/, '');
  return `${formatted} ${units[unitIdx]}`;
}

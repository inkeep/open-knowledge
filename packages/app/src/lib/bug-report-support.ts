/**
 * Bug-report primitives shared across the reporting surfaces — the compose
 * dialog, the background send manager, its toast, and the history rows.
 *
 * Two concerns live here because both outlived the dialog that once owned
 * them privately:
 *
 *   - The support-email address. `support@inkeep.com` is the fallback transport
 *     whenever the intake endpoint is absent or the upload fails, and the
 *     follow-up address once a report has a reference.
 *   - `zipBasename`. Electron main derives a report's id as the basename of
 *     the bundle it was handed, so a renderer that keys an operation the same
 *     way keys it to the same report. Import this rather than re-deriving:
 *     two spellings of "basename" that disagree on a Windows path would key
 *     the renderer's operation to a report main has never heard of.
 *   - `formatBundleSize`. Every surface shows the bundle's on-disk size, so
 *     all of them have to round it the same way.
 */

const SUPPORT_EMAIL = 'support@inkeep.com';

/** Bare mailto with a prefilled subject — used where a report already has a
 *  reference, which becomes the subject so the team can correlate the email. */
export function supportMailtoUrl(subject: string): string {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

/** Both separators, so a Windows path taken on any platform still reduces. */
export function zipBasename(zipPath: string): string {
  return zipPath.split(/[\\/]/).pop() ?? zipPath;
}

/**
 * Bundle size as the reporting surfaces render it. Deliberately not core's
 * `formatFileSize`, which reports KiB/MiB: the bug-report copy was written
 * against MB/KB labels and the two must not disagree on the same bundle.
 */
export function formatBundleSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} B`;
}

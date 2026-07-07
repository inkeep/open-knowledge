/**
 * Strip filesystem-invalid characters from a folder name. Conservative,
 * platform-agnostic: replaces `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`,
 * and null bytes (`\0`) with `-`, collapses whitespace and dashes, trims
 * leading / trailing dashes / dots / whitespace. Empty after sanitization
 * → empty string; callers validate non-empty separately.
 *
 * The set covers both macOS-forbidden (`/`) and Windows-forbidden chars
 * even though the desktop is macOS-only today — sanitizing now means a
 * future Windows port doesn't have to revisit every project name on disk.
 *
 * Null bytes are stripped for parity with `validateSpawnPath` in
 * `packages/desktop/src/main/ipc-handlers.ts`: Node 18+ throws
 * `ERR_INVALID_ARG_VALUE` on null bytes in `fs.*` calls so practical
 * exploitation is blocked, but defense-in-depth at every IPC boundary keeps
 * the pattern uniform.
 *
 * Shared between desktop main (defense-in-depth at the IPC handler) and
 * the renderer (`CreateProjectDialog` target-path caption preview).
 * Drift between the two surfaces would let the user see a folder name
 * different from what the handler actually creates — the helper lives in
 * core so both call sites import the same function.
 */
export function sanitizeFolderName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|\0]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim()
    .replace(/^[-.\s]+|[-.\s]+$/g, '');
}

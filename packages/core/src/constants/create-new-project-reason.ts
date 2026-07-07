/**
 * Failure reasons a `runCreateNew` call can throw via `CreateNewProjectError`.
 * Mirrored by the renderer's discriminated `CreateNewError` variants so an
 * out-of-band IPC failure surfaces with the same vocabulary the cascade uses.
 *
 *  - `'invalid-args'`      — renderer-supplied parent/name/editors failed
 *                            schema validation before any disk work.
 *  - `'nested-project'`    — parent or an ancestor already carries
 *                            `.ok/config.yml`; defense-in-depth re-check.
 *  - `'target-not-empty'`  — target path exists with content; defense-in-depth
 *                            re-check.
 *  - `'mkdir-failed'`      — `tracedMkdirSync(target)` threw (EACCES, EROFS, ...).
 *  - `'git-init-failed'`   — `ensureProjectGit(target)` threw.
 *  - `'init-failed'`       — `initContent(projectDir, ...)` threw.
 *  - `'discovery-failed'`  — `discoverProject(target)` returned `rejected` or
 *                            threw before scaffold could begin.
 *
 * The renderer adds a local `'unknown'` reason for IPC errors whose message
 * doesn't match any of the above prefixes (e.g., a TypeError from the main
 * process). That variant is renderer-only and intentionally omitted here.
 */
export type CreateNewProjectFailureReason =
  | 'invalid-args'
  | 'nested-project'
  | 'target-not-empty'
  | 'mkdir-failed'
  | 'git-init-failed'
  | 'init-failed'
  | 'discovery-failed';

/**
 * Runtime iteration set for the prefix-matching parser in the renderer. The
 * order matches the type union for readability — the parser is order-insensitive
 * (it tries every prefix). `as const satisfies readonly ...` preserves narrow
 * literal types while pinning structural equality to the canonical union.
 */
export const CREATE_NEW_PROJECT_FAILURE_REASONS = [
  'invalid-args',
  'nested-project',
  'target-not-empty',
  'mkdir-failed',
  'git-init-failed',
  'init-failed',
  'discovery-failed',
] as const satisfies readonly CreateNewProjectFailureReason[];

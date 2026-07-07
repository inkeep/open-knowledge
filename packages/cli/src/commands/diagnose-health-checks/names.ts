/**
 * Stable identifiers for every check exposed by `ok diagnose health`.
 *
 * Used for `--check <name>` validation and as the `name` field on every
 * `CheckResult`. New checks add a new literal here; the runner enforces
 * exhaustiveness so the human-readable + JSON outputs stay aligned.
 */

export const CHECK_NAMES = [
  'git',
  'bun',
  'config-yaml',
  'content-dir',
  'server-lock',
  'shadow-repo',
  'shadow-health',
  'macos-codesig',
] as const;

export type CheckName = (typeof CHECK_NAMES)[number];

export function isCheckName(value: string): value is CheckName {
  return (CHECK_NAMES as readonly string[]).includes(value);
}

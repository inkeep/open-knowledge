/**
 * POSIX-safe shell argument quoting. Pure — no I/O, no just-bash dependency.
 * Kept in its own module so `parse-command.ts` (the security-boundary parser)
 * doesn't have to import from `index.ts`, which carries the just-bash runtime.
 */
export function shellEscape(arg: string): string {
  if (arg === '') return "''";
  if (/^[\w.\-/]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

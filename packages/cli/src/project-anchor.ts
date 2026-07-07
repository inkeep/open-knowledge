/**
 * CLI-wide project anchoring: walk up from cwd to the nearest enclosing
 * `.ok/config.yml` so lifecycle commands invoked from a subdirectory operate
 * on the project root instead of failing with "run `ok init` first" or
 * loading schema-default config.
 *
 * Uses `findEnclosingProjectRoot` — the same walk MCP `findProjectDir`
 * performs — so the CLI and the MCP stdio server resolve the SAME root (and
 * therefore the same `server.lock`) for any directory in a tree. This is
 * deliberately NOT `resolveProjectRoot`: its git-root promotion and home-dir
 * stop are scaffolding concerns that belong to `ok init` only. Anchoring
 * finds an existing project; it never creates one.
 *
 * Closest-ancestor-wins: `findEnclosingProjectRoot` returns the first
 * (nearest) hit, so a subtree that is its own project after `ok init` stops
 * the walk there — nested projects compose like git submodules.
 */
import { findEnclosingProjectRoot } from '@inkeep/open-knowledge-server';

/**
 * Top-level subcommands that operate on an existing project and therefore
 * anchor to the enclosing project root. Everything else keeps literal-cwd
 * semantics: `init`/`seed`/`clone` scaffold NEW projects (init has its own
 * resolveProjectRoot cascade), and path-taking commands like `open` must
 * resolve relative arguments against the directory the user typed them in.
 */
const PROJECT_ANCHORED_COMMANDS: ReadonlySet<string> = new Set([
  'start',
  'stop',
  'status',
  'clean',
  'ui',
  'mcp',
  'preview',
  // `deinit` removes THIS project's OK footprint, so it must anchor to the
  // enclosing project root when run from a subdirectory. `uninstall` is global
  // and deliberately NOT anchored (it discovers projects itself).
  'deinit',
]);

/**
 * Resolve the directory the CLI should anchor to before loading config.
 *
 * Returns the enclosing project root when `commandName` is project-anchored
 * (or `undefined` — the bare-`ok` desktop-dispatch/start fallback) and the
 * nearest `.ok/config.yml` lives strictly ABOVE `cwd`. Returns `null` when
 * the command keeps literal-cwd semantics, when `cwd` is itself a project
 * root, or when no enclosing project exists (callers keep today's behavior,
 * including the "run `ok init` first" rejection).
 *
 * `findRoot` is injectable for tests; production uses the shared
 * `findEnclosingProjectRoot`.
 */
export function resolveProjectAnchor(
  commandName: string | undefined,
  cwd: string,
  findRoot: typeof findEnclosingProjectRoot = findEnclosingProjectRoot,
): string | null {
  if (commandName !== undefined && !PROJECT_ANCHORED_COMMANDS.has(commandName)) {
    return null;
  }
  const hit = findRoot(cwd);
  if (hit === null || hit.distance === 0) return null;
  return hit.rootPath;
}

let invocationCwd: string | null = null;

/**
 * Called by the preAction hook immediately before it chdirs to the anchor
 * root, preserving the directory the user actually invoked the CLI from
 * (after an explicit `--cwd`, if any). Tests pass `null` to reset the
 * module-level state between cases.
 */
export function recordInvocationCwd(cwd: string | null): void {
  invocationCwd = cwd;
}

/**
 * The directory the user invoked the CLI from. Anchored commands that accept
 * relative-path ARGUMENTS (e.g. `ok stop <dir>`) must resolve them against
 * this, not `process.cwd()` — the anchor chdir re-bases `process.cwd()` to
 * the enclosing project root, which must not change the meaning of a path
 * the user typed. Falls back to `process.cwd()` when no anchoring happened.
 */
export function getInvocationCwd(): string {
  return invocationCwd ?? process.cwd();
}

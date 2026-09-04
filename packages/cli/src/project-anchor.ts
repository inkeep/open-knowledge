import { findEnclosingProjectRoot } from '@inkeep/open-knowledge-server';

const PROJECT_ANCHORED_COMMANDS: ReadonlySet<string> = new Set([
  'start',
  'stop',
  'status',
  'clean',
  'ui',
  'mcp',
  'preview',
  'lint',
  'deinit',
  'auth',
]);

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

export function recordInvocationCwd(cwd: string | null): void {
  invocationCwd = cwd;
}

export function getInvocationCwd(): string {
  return invocationCwd ?? process.cwd();
}

import { execFileSync } from 'node:child_process';

const GIT_CONFIG_SPAWN_BUDGET_MS = 60_000;

export function configureTestGitRepository(repositoryPath: string): void;
export function configureTestGitRepository<T>(
  repositoryPath: string,
  executeGit: (args: readonly string[]) => T,
): T;
export function configureTestGitRepository<T>(
  repositoryPath: string,
  executeGit?: (args: readonly string[]) => T,
): T | void {
  const args = ['-C', repositoryPath, 'config', '--local', 'maintenance.auto', 'false'];
  if (executeGit) return executeGit(args);
  execFileSync('git', args, {
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
    ),
    stdio: 'pipe',
    timeout: GIT_CONFIG_SPAWN_BUDGET_MS,
    killSignal: 'SIGKILL',
  });
}

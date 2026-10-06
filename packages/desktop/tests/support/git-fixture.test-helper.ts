import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { inspectGitRepository } from '@inkeep/open-knowledge-core/git-repository';
import { EPHEMERAL_PROJECT_DIR_PREFIX } from '@inkeep/open-knowledge-server';
import type { Page } from '@playwright/test';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';

async function waitForServerReady(projectDir: string, apiOrigin: string): Promise<void> {
  const response = await fetch(new URL('/api/server-info', apiOrigin));
  await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`Server readiness failed for ${projectDir}: HTTP ${response.status}`);
  }
}

function configureRepositories(projectDir: string): void {
  const main = inspectGitRepository(projectDir);
  if (main.kind === 'repository') {
    if (
      main.repository.kind === 'linked' ||
      existsSync(join(main.repository.gitDir, 'HEAD')) ||
      existsSync(join(main.repository.gitDir, 'config'))
    ) {
      configureTestGitRepository(projectDir);
    }
  } else if (main.kind !== 'absent') {
    throw new Error(`Cannot inspect fixture repository at ${projectDir}: ${main.kind}`);
  }
}

export async function configureProjectGitRepositories(
  projectDir: string,
  apiOrigin: string,
): Promise<void> {
  await waitForServerReady(projectDir, apiOrigin);
  configureRepositories(projectDir);
}

export async function configureDesktopGitRepositories(
  page: Page,
  projectDir: string,
): Promise<void> {
  const apiOrigin = await page.evaluate(() => window.okDesktop?.config.apiOrigin);
  if (!apiOrigin) throw new Error(`Desktop fixture has no server origin for ${projectDir}`);
  await configureProjectGitRepositories(projectDir, apiOrigin);
}

export function readTestServerRepository(lockDir: string): {
  projectDir: string;
  apiOrigin: string;
  port: number;
} {
  const lockPath = join(lockDir, 'server.lock');
  for (const path of [dirname(dirname(lockDir)), dirname(lockDir), lockDir, lockPath]) {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Fixture server path is a symlink: ${path}`);
    }
  }
  const lock: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert(lock !== null && typeof lock === 'object', `Invalid fixture metadata at ${lockPath}`);
  assert(
    'worktreeRoot' in lock &&
      typeof lock.worktreeRoot === 'string' &&
      isAbsolute(lock.worktreeRoot),
    `Invalid fixture root at ${lockPath}`,
  );
  assert('url' in lock && typeof lock.url === 'string', `Missing fixture URL at ${lockPath}`);
  assert(
    'port' in lock && typeof lock.port === 'number' && lock.port > 0,
    `Invalid fixture port at ${lockPath}`,
  );
  const projectDir = realpathSync(lock.worktreeRoot);
  if (realpathSync(lockDir) !== join(projectDir, '.ok', 'local')) {
    throw new Error(`Fixture server root does not own ${lockPath}`);
  }
  const url = new URL(lock.url);
  if (Number(url.port) !== lock.port) {
    throw new Error(`Fixture server URL does not match port at ${lockPath}`);
  }
  return { projectDir, apiOrigin: url.origin, port: lock.port };
}

export function findEphemeralTestProject(ownedTempDir: string, apiOrigin: string): string {
  const tempDir = realpathSync(ownedTempDir);
  const origin = new URL(apiOrigin).origin;
  const matches: string[] = [];
  for (const entry of readdirSync(tempDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(EPHEMERAL_PROJECT_DIR_PREFIX)) continue;
    const projectDir = join(tempDir, entry.name);
    const lockDir = join(projectDir, '.ok', 'local');
    if (!existsSync(join(lockDir, 'server.lock'))) continue;
    const server = readTestServerRepository(lockDir);
    if (server.projectDir !== projectDir) {
      throw new Error(`Ephemeral fixture root does not match ${projectDir}`);
    }
    if (server.apiOrigin === origin) matches.push(projectDir);
  }
  const projectDir = matches[0];
  if (matches.length !== 1 || projectDir === undefined) {
    throw new Error(`Expected one ephemeral fixture for ${origin}; found ${matches.length}`);
  }
  return projectDir;
}

export async function configureEphemeralGitRepositories(
  projectDir: string,
  apiOrigin: string,
): Promise<void> {
  await waitForServerReady(projectDir, apiOrigin);
  const root = realpathSync(projectDir);
  if (!basename(root).startsWith(EPHEMERAL_PROJECT_DIR_PREFIX)) {
    throw new Error(`Unexpected ephemeral fixture root ${root}`);
  }
  configureRepositories(root);
}

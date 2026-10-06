import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import {
  configureEphemeralGitRepositories,
  configureProjectGitRepositories,
  findEphemeralTestProject,
  readTestServerRepository,
} from './git-fixture.test-helper.ts';

function git(directory: string, args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    stdio: 'pipe',
  }).trim();
}

function createShadow(projectDir: string): string {
  const shadowDir = join(projectDir, '.git', 'ok');
  git(projectDir, ['init', '--bare', shadowDir]);
  configureTestGitRepository(shadowDir);
  git(shadowDir, ['config', '--unset', 'core.bare']);
  git(shadowDir, ['config', 'core.worktree', projectDir]);
  return shadowDir;
}

function maintenance(repository: string): string {
  return git(repository, ['config', '--local', '--get', 'maintenance.auto']);
}

describe('desktop Git fixture ownership', () => {
  let root: string;
  let server: Server | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-desktop-git-fixture-')));
  });

  afterEach(async () => {
    if (server) {
      const closed = once(server, 'close');
      server.close();
      await closed;
      server = undefined;
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function serveReady(status = 200, gate = Promise.resolve()): Promise<string> {
    server = createServer((_request, response) => {
      void gate.then(() => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end('{}');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server has no port');
    return `http://127.0.0.1:${address.port}`;
  }

  test('joins readiness before configuring the main repository and leaves its shadow untouched', async () => {
    git(root, ['init']);
    configureTestGitRepository(root);
    const shadow = createShadow(root);
    git(root, ['config', '--local', 'maintenance.auto', 'true']);
    git(shadow, ['config', '--local', 'maintenance.auto', 'true']);
    const gate = Promise.withResolvers<void>();
    const origin = await serveReady(200, gate.promise);
    if (!server) throw new Error('Fixture server was not started');
    const request = once(server, 'request');
    const configured = configureProjectGitRepositories(root, origin);
    try {
      await request;
      expect(maintenance(root)).toBe('true');
      expect(maintenance(shadow)).toBe('true');
    } finally {
      gate.resolve();
      await configured;
    }
    expect(maintenance(root)).toBe('false');
    expect(maintenance(shadow)).toBe('true');
  });

  test('leaves a shadow-only project untouched without creating a main Git config', async () => {
    const shadow = createShadow(root);
    git(shadow, ['config', '--local', 'maintenance.auto', 'true']);
    await configureProjectGitRepositories(root, await serveReady());
    expect(maintenance(shadow)).toBe('true');
    expect(existsSync(join(root, '.git', 'config'))).toBe(false);
    expect(existsSync(join(root, '.git', 'HEAD'))).toBe(false);
  });

  test('configures linked worktree common config and leaves the worktree shadow untouched', async () => {
    git(root, ['init']);
    configureTestGitRepository(root);
    git(root, [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    const linked = join(root, 'linked');
    git(root, ['worktree', 'add', '--detach', linked]);
    const shadow = resolveShadowDir(linked);
    git(linked, ['init', '--bare', shadow]);
    configureTestGitRepository(shadow);
    git(root, ['config', '--local', 'maintenance.auto', 'true']);
    git(shadow, ['config', '--local', 'maintenance.auto', 'true']);
    await configureProjectGitRepositories(linked, await serveReady());
    expect(maintenance(root)).toBe('false');
    expect(maintenance(linked)).toBe('false');
    expect(maintenance(shadow)).toBe('true');
  });

  test('propagates HTTP failure without configuring the repository', async () => {
    git(root, ['init']);
    configureTestGitRepository(root);
    git(root, ['config', '--local', 'maintenance.auto', 'true']);
    await expect(configureProjectGitRepositories(root, await serveReady(503))).rejects.toThrow(
      'HTTP 503',
    );
    expect(maintenance(root)).toBe('true');
  });

  test('propagates an actual Git config lock failure', async () => {
    git(root, ['init']);
    configureTestGitRepository(root);
    git(root, ['config', '--local', 'maintenance.auto', 'true']);
    const lock = join(root, '.git', 'config.lock');
    writeFileSync(lock, 'owned contention');
    await expect(configureProjectGitRepositories(root, await serveReady())).rejects.toThrow(
      'could not lock config file',
    );
    expect(maintenance(root)).toBe('true');
    expect(readFileSync(lock, 'utf8')).toBe('owned contention');
  });

  test('selects only the matching direct owned root and rejects ambiguous or mismatched metadata', async () => {
    const origin = await serveReady();
    const port = Number(new URL(origin).port);
    const project = join(root, 'ok-ephemeral-selected');
    const lockDir = join(project, '.ok', 'local');
    mkdirSync(lockDir, { recursive: true });
    git(project, ['init']);
    configureTestGitRepository(project);
    git(project, ['config', '--local', 'maintenance.auto', 'true']);
    const shadow = createShadow(project);
    git(shadow, ['config', '--local', 'maintenance.auto', 'true']);
    const metadata = { worktreeRoot: project, url: origin, port };
    writeFileSync(join(lockDir, 'server.lock'), JSON.stringify(metadata));
    const nested = join(root, 'nested', 'ok-ephemeral-nested');
    mkdirSync(nested, { recursive: true });
    symlinkSync(project, join(root, 'ok-ephemeral-symlink'), 'junction');
    expect(findEphemeralTestProject(root, origin)).toBe(project);
    expect(() => findEphemeralTestProject(root, 'http://127.0.0.1:1')).toThrow('found 0');
    await configureEphemeralGitRepositories(project, origin);
    expect(maintenance(project)).toBe('false');
    expect(maintenance(shadow)).toBe('true');
    const duplicate = join(root, 'ok-ephemeral-duplicate');
    const duplicateLock = join(duplicate, '.ok', 'local');
    mkdirSync(duplicateLock, { recursive: true });
    writeFileSync(
      join(duplicateLock, 'server.lock'),
      JSON.stringify({ ...metadata, worktreeRoot: duplicate }),
    );
    expect(() => findEphemeralTestProject(root, origin)).toThrow('found 2');
    writeFileSync(join(duplicateLock, 'server.lock'), JSON.stringify(metadata));
    expect(() => readTestServerRepository(duplicateLock)).toThrow('does not own');
    writeFileSync(
      join(duplicateLock, 'server.lock'),
      JSON.stringify({ ...metadata, worktreeRoot: duplicate, url: 'not-a-url' }),
    );
    expect(() => readTestServerRepository(duplicateLock)).toThrow();
  });
});

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathspecArgs } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import { loadConfig } from '../config/loader.ts';
import { runClone } from './clone.ts';

const fixtures: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function initializeRepository(directory: string): void {
  mkdirSync(directory, { recursive: true });
  git(directory, ['init', '--initial-branch=main']);
  configureTestGitRepository(directory);
}

describe('clone initialization', () => {
  it('initializes the checkout without changing its enclosing project', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'ok-clone-init-'));
    fixtures.push(fixture);
    const home = join(fixture, 'home');
    const template = join(fixture, 'empty-template');
    mkdirSync(home);
    mkdirSync(template);

    for (const name of Object.keys(process.env)) {
      if (name.startsWith('GIT_')) vi.stubEnv(name, undefined);
    }
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
    vi.stubEnv('OK_CHANNEL', 'stable');
    vi.stubEnv('DO_NOT_TRACK', '1');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    writeFileSync(
      join(home, '.gitconfig'),
      `[user]\n  name = Fixture\n  email = fixture@example.invalid\n` +
        `[commit]\n  gpgsign = false\n[maintenance]\n  auto = false\n[gc]\n  auto = 0\n`,
    );
    git(fixture, ['config', '--file', join(home, '.gitconfig'), 'init.templateDir', template]);

    const source = join(fixture, 'source');
    initializeRepository(source);
    writeFileSync(join(source, 'README.md'), '# Cloned content\n');
    git(source, ['add', ...pathspecArgs(['README.md'])]);
    git(source, ['commit', '-m', 'Seed source']);

    const ancestor = join(home, 'outer');
    initializeRepository(ancestor);
    mkdirSync(join(ancestor, '.ok'));
    writeFileSync(join(ancestor, '.ok', 'config.yml'), 'content:\n  dir: .\n');
    const ignore = 'user-rule/\n.claude/skills/open-knowledge/\n.cursor/skills/open-knowledge/\n';
    const localIgnore = 'local/\n';
    writeFileSync(join(ancestor, '.gitignore'), ignore);
    writeFileSync(join(ancestor, '.ok', '.gitignore'), localIgnore);
    git(ancestor, ['add', ...pathspecArgs(['.gitignore', '.ok/config.yml', '.ok/.gitignore'])]);
    git(ancestor, ['commit', '-m', 'Seed enclosing project']);

    const url = 'http://127.0.0.1:1/fixture/source.git';
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${pathToFileURL(source).href}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', url);

    const target = join(ancestor, 'cloned');
    const result = await runClone(
      url,
      {
        dir: target,
        json: true,
        _detectGhFn: () => ({ available: true, token: 'fixture-only' }),
      },
      loadConfig(ancestor).config,
      ancestor,
    );
    configureTestGitRepository(result);

    expect(result).toBe(target);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# Cloned content\n');
    expect.soft(readFileSync(join(ancestor, '.gitignore'), 'utf8')).toBe(ignore);
    expect.soft(readFileSync(join(ancestor, '.ok', '.gitignore'), 'utf8')).toBe(localIgnore);
    expect.soft(existsSync(join(target, '.ok', 'config.yml'))).toBe(true);
  });
});

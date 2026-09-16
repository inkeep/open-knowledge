import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

const isolated = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => isolated.home,
}));

let root: string;
let server: BootedServer | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-boot-skill-ownership-')));
  isolated.home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-boot-skill-home-')));
});

afterEach(async () => {
  try {
    await server?.destroy();
  } finally {
    server = undefined;
    rmSync(root, { recursive: true, force: true });
    rmSync(isolated.home, { recursive: true, force: true });
  }
});

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

test('startup preserves tracked dangling skill links without a legacy store', async () => {
  git('init', '--quiet', '--initial-branch=main');
  writeFileSync(join(root, '.gitignore'), '.ok/\n');
  const target = '../../shared-skills/retired';
  const links = ['.agents/skills/retired', '.codex/skills/retired'];
  for (const host of ['.agents', '.codex']) {
    mkdirSync(join(root, host, 'skills'), { recursive: true });
    symlinkSync(target, join(root, host, 'skills', 'retired'), 'dir');
  }
  git('add', '.');
  git(
    '-c',
    'user.name=Skill test',
    '-c',
    'user.email=skill-test@example.com',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--quiet',
    '-m',
    'Seed tracked skill links',
  );
  expect(git('status', '--porcelain')).toBe('');
  expect(git('ls-files', '--stage')).toContain('120000');
  expect(existsSync(join(root, '.ok', 'skills'))).toBe(false);

  server = await bootCompositionRig(root, { configHomedirOverride: isolated.home });
  await server.ready;

  expect(git('status', '--porcelain')).toBe('');
  for (const link of links) {
    expect(lstatSync(join(root, link)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, link))).toBe(target);
  }
}, 60_000);

test.each([false, true])(
  'startup preserves untracked dangling links when a same-name legacy skill exists: %s',
  async (legacySkillExists) => {
    const target = '../../shared-skills/retired';
    const link = join(root, '.agents', 'skills', 'retired');
    mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
    symlinkSync(target, link, 'dir');
    if (legacySkillExists) {
      const source = join(root, '.ok', 'skills', 'retired');
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, 'SKILL.md'), '---\nname: retired\n---\n# Legacy skill\n');
    }

    server = await bootCompositionRig(root, { configHomedirOverride: isolated.home });
    await server.ready;

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    if (legacySkillExists) {
      expect(readFileSync(join(root, '.ok', 'skills', 'retired', 'SKILL.md'), 'utf8')).toBe(
        '---\nname: retired\n---\n# Legacy skill\n',
      );
    }
  },
  60_000,
);

test('startup still migrates known legacy store installations into editor directories', async () => {
  const source = join(root, '.ok', 'skills', 'legacy');
  const host = join(root, '.codex', 'skills');
  const content = '---\nname: legacy\n---\n# Legacy skill\n';
  mkdirSync(source, { recursive: true });
  mkdirSync(host, { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), content);
  symlinkSync('../../.ok/skills/legacy', join(host, 'legacy'), 'dir');

  server = await bootCompositionRig(root, { configHomedirOverride: isolated.home });
  await server.ready;

  expect(lstatSync(join(host, 'legacy')).isDirectory()).toBe(true);
  expect(readFileSync(join(host, 'legacy', 'SKILL.md'), 'utf8')).toBe(content);
  expect(existsSync(source)).toBe(false);
}, 60_000);

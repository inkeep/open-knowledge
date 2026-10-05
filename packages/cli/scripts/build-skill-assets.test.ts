import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_IDS } from '@inkeep/open-knowledge-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSocketPathOverflowingTempDir } from '../../../test-support/temp-dir.test-helper.ts';
import { okVitestBase } from '../../../test-support/vitest.base';
import { composeSkillAssets, resolveSkillAssetPaths } from './build-skill-assets.ts';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ROOT = join(PACKAGE_ROOT, '..', 'server');
const SOURCE_SKILLS = join(SERVER_ROOT, 'assets', 'skills');
const SOURCE_PACKS = join(SOURCE_SKILLS, 'packs');
const SHIPPED_SKILLS = join(PACKAGE_ROOT, 'dist', 'assets', 'skills');
const DECOMPOSED_MEMBER = join('packs', 'software-lifecycle', 'write-a-spec', 'SKILL.md');
const commandFixtures: string[] = [];

let scratchServerRoot: string;
let scratchCliRoot: string;
let scratchSkills: string;
let scratchRoot: string;

function sourcePackIds(): string[] {
  return readdirSync(SOURCE_PACKS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function runSkillAssetCommand(depth: string) {
  const root = mkdtempSync(join(tmpdir(), 'ca-'));
  commandFixtures.push(root);
  const cliRoot = join(root, 'cli');
  const serverRoot = join(root, 'server');
  for (const [sourceRoot, targetRoot, files] of [
    [PACKAGE_ROOT, cliRoot, ['scripts/build-skill-assets.ts']],
    [
      SERVER_ROOT,
      serverRoot,
      [
        'scripts/build-skill-bundles.ts',
        'src/skill-bundles.ts',
        'src/skill-pack-sources.ts',
        'src/build-skill-zip.ts',
      ],
    ],
  ] as const) {
    for (const file of files) {
      const target = join(targetRoot, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(sourceRoot, file), target);
    }
  }
  cpSync(SOURCE_SKILLS, join(serverRoot, 'assets', 'skills'), {
    recursive: true,
    dereference: true,
  });
  const { packageManager } = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, '../../package.json'), 'utf8'),
  ) as { packageManager: string };
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  writeFileSync(
    join(cliRoot, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      packageManager,
      scripts: { 'build:skill-asset': manifest.scripts['build:skill-asset'] },
    }),
  );
  writeFileSync(
    join(serverRoot, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  symlinkSync(join(PACKAGE_ROOT, '../../node_modules'), join(root, 'node_modules'), 'junction');
  symlinkSync(join(SERVER_ROOT, 'node_modules'), join(serverRoot, 'node_modules'), 'junction');
  const temporary = depth === 'deep' ? createSocketPathOverflowingTempDir(root) : join(root, 'tmp');
  mkdirSync(temporary, { recursive: true });
  const result = spawnSync('pnpm', ['run', 'build:skill-asset'], {
    cwd: cliRoot,
    env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
    encoding: 'utf8',
    timeout: okVitestBase.test.testTimeout,
  });
  return { result, cliRoot, serverRoot };
}

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'ok-cli-skill-assets-'));
  scratchServerRoot = join(scratchRoot, 'server');
  scratchCliRoot = join(scratchRoot, 'cli');
  scratchSkills = join(scratchCliRoot, 'dist', 'assets', 'skills');
  mkdirSync(join(scratchServerRoot, 'assets'), { recursive: true });
  cpSync(SOURCE_SKILLS, join(scratchServerRoot, 'assets', 'skills'), { recursive: true });
  mkdirSync(scratchCliRoot, { recursive: true });
  composeSkillAssets(resolveSkillAssetPaths(scratchCliRoot));
});

afterAll(() => {
  if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
  for (const root of commandFixtures) rmSync(root, { recursive: true, force: true });
});

describe('composing skill assets for a cli package root', () => {
  it('writes every bundle under that package root', () => {
    for (const bundle of BUNDLE_IDS) {
      expect(existsSync(join(scratchSkills, bundle, 'SKILL.md'))).toBe(true);
    }
  });

  it('writes every source pack under that package root', () => {
    const packs = sourcePackIds();
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      expect(existsSync(join(scratchSkills, 'packs', pack, 'SKILL.md'))).toBe(true);
    }
  });

  it('writes the decomposed member skills, not just the pack roots', () => {
    const member = join(scratchSkills, DECOMPOSED_MEMBER);
    expect(existsSync(member)).toBe(true);
    expect(readFileSync(member, 'utf-8').length).toBeGreaterThan(0);
  });

  it('never brings the server package dist into existence', () => {
    expect(existsSync(join(scratchSkills, 'discovery', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(scratchServerRoot, 'dist'))).toBe(false);
  });
});

describe('the default skill-asset paths', () => {
  it('reads the server package source assets, never a dist tree', () => {
    const { skillsDir } = resolveSkillAssetPaths();
    expect(skillsDir).toBe(join(SERVER_ROOT, 'assets', 'skills'));
    expect(skillsDir.split(sep)).not.toContain('dist');
  });

  it('writes into the cli package dist', () => {
    expect(resolveSkillAssetPaths().distDir).toBe(SHIPPED_SKILLS);
  });
});

describe('the shipped build:skill-asset step', () => {
  it.each(['ordinary', 'deep'])('runs the cli composer and nothing else (%s TMPDIR)', (depth) => {
    const { result, cliRoot, serverRoot } = runSkillAssetCommand(depth);
    const assets = join(cliRoot, 'dist', 'assets', 'skills');
    const expectedFiles = [
      ...BUNDLE_IDS.map((bundle) => join(assets, bundle, 'SKILL.md')),
      ...sourcePackIds().map((pack) => join(assets, 'packs', pack, 'SKILL.md')),
      join(assets, DECOMPOSED_MEMBER),
    ];
    const member = join(assets, DECOMPOSED_MEMBER);
    expect(
      {
        status: result.status,
        files: expectedFiles.filter((file) => existsSync(file)),
        memberHasContent: existsSync(member) && readFileSync(member, 'utf8').length > 0,
        serverDistExists: existsSync(join(serverRoot, 'dist')),
      },
      result.stderr,
    ).toEqual({
      status: 0,
      files: expectedFiles,
      memberHasContent: true,
      serverDistExists: false,
    });
  });

  it('leaves every bundle, pack and decomposed member in the built cli dist', () => {
    for (const bundle of BUNDLE_IDS) {
      expect(existsSync(join(SHIPPED_SKILLS, bundle, 'SKILL.md'))).toBe(true);
    }
    const packs = sourcePackIds();
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      expect(existsSync(join(SHIPPED_SKILLS, 'packs', pack, 'SKILL.md'))).toBe(true);
    }
    expect(existsSync(join(SHIPPED_SKILLS, DECOMPOSED_MEMBER))).toBe(true);
  });
});

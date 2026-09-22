import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as coreServer from '@inkeep/open-knowledge-core/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolveBundledSkillDir } from '../build-skill-zip.ts';
import { getLogger } from '../logger.ts';
import {
  PROJECT_SKILL_ENTRY,
  ProjectSkillSymlinkError,
  projectSkillStageDir,
  stagedBundleMatches,
  stageProjectSkill,
} from './project-skill-staging.ts';

const log = getLogger('project-skill-staging-test');

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'project-skill-staging-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function writeBundle(dir: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

function listFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, base));
    else out.push(abs.slice(base.length + 1));
  }
  return out;
}

const SMALL_BUNDLE = {
  [PROJECT_SKILL_ENTRY]: '# skill\n',
  'references/a.md': 'alpha\n',
  'references/deep/b.md': 'beta\n',
};

describe('stageProjectSkill', () => {
  test('stages the bundle byte-for-byte under <localDir>/agent-skill/open-knowledge', async () => {
    const localDir = tmp();
    const source = writeBundle(tmp(), SMALL_BUNDLE);
    const staged = await stageProjectSkill({ localDir, sourceDir: source, log });
    expect(staged).toBe(projectSkillStageDir(localDir));
    expect(listFiles(staged)).toEqual(listFiles(source));
    for (const rel of listFiles(source)) {
      expect(readFileSync(join(staged, rel))).toEqual(readFileSync(join(source, rel)));
    }
    expect(
      readdirSync(join(localDir, 'agent-skill')).filter((n) => n.startsWith('.install-')),
    ).toEqual([]);
  });

  test('restores a modified or truncated staged copy on the next spawn', async () => {
    const localDir = tmp();
    const source = writeBundle(tmp(), SMALL_BUNDLE);
    const staged = await stageProjectSkill({ localDir, sourceDir: source, log });
    writeFileSync(join(staged, PROJECT_SKILL_ENTRY), 'tampered\n');
    rmSync(join(staged, 'references', 'deep'), { recursive: true, force: true });
    expect(stagedBundleMatches(source, staged)).toBe(false);

    await stageProjectSkill({ localDir, sourceDir: source, log });
    expect(readFileSync(join(staged, PROJECT_SKILL_ENTRY), 'utf8')).toBe('# skill\n');
    expect(readFileSync(join(staged, 'references', 'deep', 'b.md'), 'utf8')).toBe('beta\n');
    expect(stagedBundleMatches(source, staged)).toBe(true);
  });

  test.each(['references/a.md', 'references/deep'])(
    'removes retired bundle entries on the next spawn: %s',
    async (retiredPath) => {
      const localDir = tmp();
      const source = writeBundle(tmp(), SMALL_BUNDLE);
      const staged = await stageProjectSkill({ localDir, sourceDir: source, log });
      rmSync(join(source, retiredPath), { recursive: true });

      expect(stagedBundleMatches(source, staged)).toBe(false);
      await stageProjectSkill({ localDir, sourceDir: source, log });

      expect(existsSync(join(staged, retiredPath))).toBe(false);
      expect(listFiles(staged)).toEqual(listFiles(source));
      expect(stagedBundleMatches(source, staged)).toBe(true);
    },
  );

  test('leaves an identical staged copy untouched instead of replacing it', async () => {
    const localDir = tmp();
    const source = writeBundle(tmp(), SMALL_BUNDLE);
    const staged = await stageProjectSkill({ localDir, sourceDir: source, log });
    const before = statSync(join(staged, PROJECT_SKILL_ENTRY));
    await new Promise((r) => setTimeout(r, 20));
    await stageProjectSkill({ localDir, sourceDir: source, log });
    const after = statSync(join(staged, PROJECT_SKILL_ENTRY));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test('concurrent spawns converge on one complete copy', async () => {
    const localDir = tmp();
    const source = writeBundle(tmp(), SMALL_BUNDLE);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => stageProjectSkill({ localDir, sourceDir: source, log })),
    );
    expect(new Set(results).size).toBe(1);
    expect(stagedBundleMatches(source, results[0] as string)).toBe(true);
    expect(
      readdirSync(join(localDir, 'agent-skill')).filter((n) => n.startsWith('.install-')),
    ).toEqual([]);
  });

  test('refuses a symlinked destination or parent and writes nothing through it', async () => {
    const localDir = tmp();
    const source = writeBundle(tmp(), SMALL_BUNDLE);
    const elsewhere = tmp();
    mkdirSync(localDir, { recursive: true });
    symlinkSync(elsewhere, join(localDir, 'agent-skill'), 'dir');
    await expect(stageProjectSkill({ localDir, sourceDir: source, log })).rejects.toBeInstanceOf(
      ProjectSkillSymlinkError,
    );
    expect(readdirSync(elsewhere)).toEqual([]);

    const localDir2 = tmp();
    mkdirSync(join(localDir2, 'agent-skill'), { recursive: true });
    symlinkSync(elsewhere, projectSkillStageDir(localDir2), 'dir');
    await expect(
      stageProjectSkill({ localDir: localDir2, sourceDir: source, log }),
    ).rejects.toBeInstanceOf(ProjectSkillSymlinkError);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test('refuses a symlink installed while waiting for the commit lock', async () => {
    const localDir = tmp();
    const source = writeBundle(tmp(), SMALL_BUNDLE);
    const elsewhere = writeBundle(tmp(), SMALL_BUNDLE);
    const stagedDir = projectSkillStageDir(localDir);
    const lockPath = `${stagedDir}.install.lock`;
    mkdirSync(join(localDir, 'agent-skill'));
    writeFileSync(lockPath, 'held');
    const lock = vi.spyOn(coreServer, 'withFileLock');
    const staging = stageProjectSkill({ localDir, sourceDir: source, log });
    const rejected = expect(staging).rejects.toBeInstanceOf(ProjectSkillSymlinkError);
    try {
      await vi.waitFor(() => expect(lock).toHaveBeenCalled());
      symlinkSync(elsewhere, stagedDir, 'dir');
    } finally {
      rmSync(lockPath, { force: true });
    }
    await rejected;
    expect(listFiles(elsewhere)).toEqual(Object.keys(SMALL_BUNDLE).sort());
    expect(readFileSync(join(elsewhere, PROJECT_SKILL_ENTRY), 'utf8')).toBe('# skill\n');
  });

  test('rejects a missing source without creating the staged folder', async () => {
    const localDir = tmp();
    await expect(
      stageProjectSkill({ localDir, sourceDir: join(tmp(), 'nope'), log }),
    ).rejects.toThrow();
    expect(existsSync(projectSkillStageDir(localDir))).toBe(false);
  });

  test('stages the shipped project bundle with SKILL.md at the root', async () => {
    const localDir = tmp();
    const source = resolveBundledSkillDir('project', { checkDesktop: false });
    const staged = await stageProjectSkill({ localDir, sourceDir: source, log });
    expect(existsSync(join(staged, PROJECT_SKILL_ENTRY))).toBe(true);
    expect(listFiles(staged)).toEqual(listFiles(source));
  });
});

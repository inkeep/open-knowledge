import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { InPlaceSkill } from './in-place-skills.ts';
import {
  clearSkillPlacements,
  readSkillPlacements,
  recordSkillPlacement,
  resyncRecordedSkillCopies,
} from './skill-placements.ts';
import {
  readKnownSkillPlacementRoots,
  readSkillPlacementsStore,
  readSkillSourceHostPreferences,
} from './skill-placements-store.ts';

let root: string;
let projectDir: string;
let outsideDir: string;

function writeSkill(dir: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: guarded\ndescription: d\n---\n\n${body}\n`);
  return parseSkillDir(dir)?.contentHash as string;
}

function canonicalSkill(hash: string): InPlaceSkill {
  return {
    name: 'guarded',
    description: 'd',
    dir: '.claude/skills/guarded',
    hosts: ['claude'],
    linkedHosts: [],
    conflictHosts: [],
    copyDirs: [],
    contentHash: hash,
  };
}

function writeLedger(path: string, hash: string): void {
  mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
  writeFileSync(
    join(projectDir, '.ok', 'local', 'skill-placements.json'),
    JSON.stringify({
      schema: 1,
      skills: { guarded: [{ path, mode: 'copy', hash }] },
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-placement-safety-'));
  projectDir = join(root, 'project');
  outsideDir = join(root, 'outside');
  mkdirSync(projectDir);
  mkdirSync(outsideDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('placement ledger path safety', () => {
  test('one parser feeds safe placements, roots, and source preferences', () => {
    mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'local', 'skill-placements.json'),
      JSON.stringify({
        schema: 1,
        skills: {
          guarded: [
            { path: '.tim/skills/guarded', mode: 'copy', hash: 'abc' },
            { path: '../outside/guarded', mode: 'copy', hash: 'def' },
          ],
        },
        roots: ['.custom/skills', '../outside'],
        sources: { guarded: 'claude' },
      }),
    );

    expect(readSkillPlacementsStore(projectDir).skills.guarded).toEqual([
      { path: '.tim/skills/guarded', mode: 'copy', hash: 'abc' },
    ]);
    expect(readKnownSkillPlacementRoots(projectDir)).toEqual(['.custom/skills', '.tim/skills']);
    expect(readSkillSourceHostPreferences(projectDir)).toEqual({ guarded: 'claude' });
  });

  test('a traversal entry cannot refresh or remove a bundle outside the project', async () => {
    const canonicalHash = writeSkill(join(projectDir, '.claude/skills/guarded'), '# New');
    const outsideSkill = join(outsideDir, 'guarded');
    const outsideHash = writeSkill(outsideSkill, '# Outside');
    writeLedger(relative(projectDir, outsideSkill), outsideHash);

    expect(readSkillPlacements(projectDir)).toEqual({});
    expect(
      await resyncRecordedSkillCopies(projectDir, projectDir, [canonicalSkill(canonicalHash)]),
    ).toBe(0);
    expect(readFileSync(join(outsideSkill, 'SKILL.md'), 'utf-8')).toContain('# Outside');
  });

  test('a placement beneath an escaping parent symlink is ignored', async () => {
    const canonicalHash = writeSkill(join(projectDir, '.claude/skills/guarded'), '# New');
    const outsideSkill = join(outsideDir, 'guarded');
    const outsideHash = writeSkill(outsideSkill, '# Outside');
    symlinkSync(outsideDir, join(projectDir, 'linked'), 'dir');
    writeLedger('linked/guarded', outsideHash);

    expect(readSkillPlacements(projectDir)).toEqual({});
    expect(
      await resyncRecordedSkillCopies(projectDir, projectDir, [canonicalSkill(canonicalHash)]),
    ).toBe(0);
    expect(readFileSync(join(outsideSkill, 'SKILL.md'), 'utf-8')).toContain('# Outside');
  });
});

describe('concurrent ledger writes', () => {
  test('every placement recorded in parallel survives', async () => {
    // The ledger is one JSON file, so each record is read-all → edit → write-all
    // with an await in between. Converting a skill's locations fires one request
    // per location at once; unserialized they all read the same starting file and
    // overwrite each other, leaving the ledger disagreeing with the disk and the
    // clobbered locations reporting themselves as "changed outside".
    const paths = [
      '.claude/skills/parallel',
      '.cursor/skills/parallel',
      '.github/skills/parallel',
      '.opencode/skills/parallel',
      '.pi/skills/parallel',
      '.codex/skills/parallel',
    ];
    for (const path of paths) writeSkill(join(projectDir, path), 'body');

    await Promise.all(
      paths.map((path) => recordSkillPlacement(projectDir, 'parallel', { path, mode: 'copy' })),
    );

    const recorded = (readSkillPlacements(projectDir).parallel ?? []).map((p) => p.path).sort();
    expect(recorded).toEqual([...paths].sort());
  });
});

describe('clearSkillPlacements', () => {
  test('drops every record for one skill and leaves the others alone', async () => {
    writeSkill(join(projectDir, '.claude/skills/guarded'), '# A');
    writeSkill(join(projectDir, '.agents/skills/guarded'), '# A');
    writeSkill(join(projectDir, '.claude/skills/other'), '# B');
    await recordSkillPlacement(projectDir, 'guarded', {
      path: '.claude/skills/guarded',
      mode: 'link',
    });
    await recordSkillPlacement(projectDir, 'guarded', {
      path: '.agents/skills/guarded',
      mode: 'link',
    });
    await recordSkillPlacement(projectDir, 'other', { path: '.claude/skills/other', mode: 'copy' });

    await clearSkillPlacements(projectDir, 'guarded');

    const store = readSkillPlacementsStore(projectDir);
    // The stale "link" records are what a move leaves behind to be re-read as
    // drift once the round trip re-creates those locations as copies.
    expect(store.skills.guarded).toBeUndefined();
    expect(store.skills.other).toHaveLength(1);
  });

  test('clearing a skill with no records is a no-op', async () => {
    await expect(clearSkillPlacements(projectDir, 'never-placed')).resolves.toBeUndefined();
  });
});

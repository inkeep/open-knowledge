import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { rewriteSkillRefsAcrossScope } from './skill-ref-rename.ts';

let contentDir: string;

const writeSkill = (name: string, body: string, refs: Record<string, string> = {}): void => {
  const dir = resolve(contentDir, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'SKILL.md'), `---\nname: ${name}\n---\n\n${body}`);
  for (const [rel, text] of Object.entries(refs)) {
    const abs = resolve(dir, 'references', rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
};

const read = (name: string, rel = 'SKILL.md'): string =>
  readFileSync(resolve(contentDir, '.claude', 'skills', name, rel), 'utf-8');

beforeEach(() => {
  contentDir = mkdtempSync(join(tmpdir(), 'ok-skill-ref-rename-'));
});
afterEach(() => {
  rmSync(contentDir, { recursive: true, force: true });
});

describe('rewriteSkillRefsAcrossScope', () => {
  test('carries inbound refs from other skills, in prose and inline code', () => {
    writeSkill('grilling', 'Start with /grill-me, then `/grill-me` again.\n');
    writeSkill('plating', 'Unrelated: /grill-me-later stays.\n');
    writeSkill('grill-me', 'I am the one being renamed.\n');

    const out = rewriteSkillRefsAcrossScope({
      base: contentDir,
      scope: 'project',
      fromName: 'grill-me',
      toName: 'searing',
    });

    expect(read('grilling')).toContain('Start with /searing, then `/searing` again.');
    // A longer slug that merely starts with the old name is a different skill.
    expect(read('plating')).toContain('/grill-me-later');
    expect(out.map((r) => r.rel)).toEqual(['SKILL.md']);
    expect(out[0]?.dir).toBe('.claude/skills/grilling');
  });

  test('reaches references/**.md, nested', () => {
    writeSkill('grilling', 'No ref here.\n', {
      'deep/notes.md': 'See /grill-me for the sear.\n',
    });
    writeSkill('grill-me', 'body\n');

    const out = rewriteSkillRefsAcrossScope({
      base: contentDir,
      scope: 'project',
      fromName: 'grill-me',
      toName: 'searing',
    });

    expect(read('grilling', 'references/deep/notes.md')).toBe('See /searing for the sear.\n');
    expect(out.map((r) => r.rel)).toEqual(['references/deep/notes.md']);
  });

  test('touches nothing when no body references the old name', () => {
    writeSkill('grilling', 'Nothing to see.\n');
    const before = read('grilling');

    expect(
      rewriteSkillRefsAcrossScope({
        base: contentDir,
        scope: 'project',
        fromName: 'grill-me',
        toName: 'searing',
      }),
    ).toEqual([]);
    expect(read('grilling')).toBe(before);
  });

  // The global branch routes through a DIFFERENT scanner (scanGlobalInPlaceSkills)
  // with different root resolution. Without this, a regression there would leave
  // every inbound ref stale on a global rename with no test signal.
  test('carries refs at global scope too, through the other scanner', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-skill-ref-rename-home-'));
    try {
      const mk = (name: string, body: string) => {
        const dir = resolve(home, '.claude', 'skills', name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'SKILL.md'), `---\nname: ${name}\n---\n\n${body}`);
      };
      mk('grilling', 'Start with /grill-me.\n');
      mk('grill-me', 'I am being renamed.\n');

      const out = rewriteSkillRefsAcrossScope({
        base: home,
        scope: 'global',
        fromName: 'grill-me',
        toName: 'searing',
      });

      expect(out.map((r) => r.dir)).toEqual(['.claude/skills/grilling']);
      expect(
        readFileSync(resolve(home, '.claude', 'skills', 'grilling', 'SKILL.md'), 'utf-8'),
      ).toContain('Start with /searing.');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a no-op rename writes nothing', () => {
    writeSkill('grilling', 'Load /grill-me.\n');
    expect(
      rewriteSkillRefsAcrossScope({
        base: contentDir,
        scope: 'project',
        fromName: 'grill-me',
        toName: 'grill-me',
      }),
    ).toEqual([]);
    expect(read('grilling')).toContain('/grill-me');
  });
});

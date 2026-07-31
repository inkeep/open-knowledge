import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  externalSkillAbsPath,
  externalSkillDir,
  registerExternalSkill,
  unregisterExternalSkill,
} from './external-skill-registry.ts';

/** Simulates a detected skill living at a harness dir outside any project. */
function freshSkillDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ok-ext-skill-'));
  writeFileSync(resolve(dir, 'SKILL.md'), '# original\n');
  return dir;
}

describe('external-skill-registry — guarded external write core', () => {
  afterEach(() => {
    unregisterExternalSkill('foo');
    unregisterExternalSkill('BAD');
  });

  test('unregistered skill resolves to null (falls through to normal path)', () => {
    expect(externalSkillDir('never')).toBeNull();
    expect(externalSkillAbsPath('never', null)).toBeNull();
  });

  test('registered SKILL.md resolves under the registered dir', () => {
    const dir = freshSkillDir();
    registerExternalSkill('foo', dir);
    try {
      expect(externalSkillAbsPath('foo', null)).toBe(resolve(dir, 'SKILL.md'));
      expect(externalSkillAbsPath('foo', 'references/setup')).toBe(
        resolve(dir, 'references', 'setup'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('byte-fidelity round-trip: write to the resolved SKILL.md, read back verbatim', () => {
    const dir = freshSkillDir();
    registerExternalSkill('foo', dir);
    try {
      // Bytes with the kinds of content a skill carries: frontmatter, unicode, a
      // trailing newline, backslashes — must land verbatim (precedent #57).
      const content = '---\nname: foo\n---\n\n# Foo café\n\nUse `\\d+` and 日本語.\n';
      const target = externalSkillAbsPath('foo', null);
      expect(target).not.toBeNull();
      writeFileSync(target as string, content);
      // The write landed on the REAL skill file, not a copy elsewhere.
      expect(target).toBe(resolve(dir, 'SKILL.md'));
      expect(readFileSync(resolve(dir, 'SKILL.md'), 'utf8')).toBe(content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('containment: a bundle rel with `..` throws, never escapes the dir', () => {
    const dir = freshSkillDir();
    registerExternalSkill('foo', dir);
    try {
      expect(() => externalSkillAbsPath('foo', '../../../etc/passwd')).toThrow(
        /invalid bundle path/,
      );
      expect(() => externalSkillAbsPath('foo', 'references/../../escape')).toThrow(
        /invalid bundle path/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('containment: an invalid skill name throws (grammar gate)', () => {
    // A name that passed registration but violates the slug grammar must still be
    // refused at resolve time (defense-in-depth).
    registerExternalSkill('BAD', '/tmp/whatever');
    expect(() => externalSkillAbsPath('BAD', null)).toThrow(/invalid skill name/);
  });

  test('every resolved path stays under the registered dir', () => {
    const dir = freshSkillDir();
    registerExternalSkill('foo', dir);
    try {
      for (const rel of [null, 'references/a', 'scripts/build']) {
        const abs = externalSkillAbsPath('foo', rel);
        expect(abs).not.toBeNull();
        expect((abs as string).startsWith(dir + sep)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

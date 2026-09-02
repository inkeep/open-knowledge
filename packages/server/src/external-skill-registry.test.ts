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
      const content = '---\nname: foo\n---\n\n# Foo café\n\nUse `\\d+` and 日本語.\n';
      const target = externalSkillAbsPath('foo', null);
      expect(target).not.toBeNull();
      writeFileSync(target as string, content);
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

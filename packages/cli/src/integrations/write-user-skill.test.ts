import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { removeUserSkill, userSkillPresentAnywhere, writeUserSkill } from './write-user-skill.ts';

const DISCOVERY_DIR = 'open-knowledge-discovery';

describe('writeUserSkill', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ok-write-user-skill-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('installs the discovery bundle into the agent own skills root', () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });

    const result = writeUserSkill('claude', home);

    expect(result.action).toBe('written');
    expect(existsSync(join(home, '.claude', 'skills', DISCOVERY_DIR, 'SKILL.md'))).toBe(true);
  });

  test('reports skipped-unsupported for an agent with no user skills root', () => {
    const result = writeUserSkill('claude-desktop', home);
    expect(result.action).toBe('skipped-unsupported');
    expect(result.path).toBe('');
  });

  describe('a skills root shared with another agent', () => {
    function seedSharedRoot(): void {
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
      mkdirSync(join(home, '.codex'), { recursive: true });
      symlinkSync(join(home, '.claude', 'skills'), join(home, '.codex', 'skills'), 'dir');
    }

    test('writes through the link, which is what a shared folder means', () => {
      seedSharedRoot();

      const result = writeUserSkill('codex', home);

      expect(result.action).toBe('written');
      expect(existsSync(join(home, '.claude', 'skills', DISCOVERY_DIR))).toBe(true);
    });

    test('writes from either side — sharing is not directional', () => {
      seedSharedRoot();

      const result = writeUserSkill('claude', home);

      expect(result.action).toBe('written');
      expect(existsSync(join(home, '.codex', 'skills', DISCOVERY_DIR))).toBe(true);
    });

    test('still installs through an alias no other agent reads', () => {
      mkdirSync(join(home, '.vendor', 'skills'), { recursive: true });
      mkdirSync(join(home, '.codex'), { recursive: true });
      symlinkSync(join(home, '.vendor', 'skills'), join(home, '.codex', 'skills'), 'dir');

      const result = writeUserSkill('codex', home);

      expect(result.action).toBe('written');
      expect(existsSync(join(home, '.vendor', 'skills', DISCOVERY_DIR, 'SKILL.md'))).toBe(true);
    });
  });

  test('a blocked destination reports failed with a non-empty message', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills'), 'not a directory');

    const result = writeUserSkill('claude', home);

    expect(result.action).toBe('failed');
    expect(result.error).toBeTruthy();
  });
});

describe('userSkillPresentAnywhere', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ok-present-anywhere-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('false on an empty home', () => {
    expect(userSkillPresentAnywhere(home)).toBe(false);
  });

  test('true when the vendor-neutral hub holds it', () => {
    mkdirSync(join(home, '.agents', 'skills', DISCOVERY_DIR), { recursive: true });

    expect(userSkillPresentAnywhere(home)).toBe(true);
  });

  test('true when a single editor root holds it', () => {
    mkdirSync(join(home, '.cursor', 'skills', DISCOVERY_DIR), { recursive: true });

    expect(userSkillPresentAnywhere(home)).toBe(true);
  });

  test('false when a host dir exists but carries no bundle', () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });

    expect(userSkillPresentAnywhere(home)).toBe(false);
  });

  test('the last removal empties it', () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    writeUserSkill('claude', home);
    expect(userSkillPresentAnywhere(home)).toBe(true);

    rmSync(join(home, '.claude', 'skills', DISCOVERY_DIR), { recursive: true, force: true });

    expect(userSkillPresentAnywhere(home)).toBe(false);
  });
});

describe('a user skills folder aliased outside the home directory', () => {
  let root: string;
  let home: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ok-user-skill-escape-'));
    home = join(root, 'home');
    outside = join(root, 'elsewhere', 'skills');
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(outside, DISCOVERY_DIR), { recursive: true });
    writeFileSync(join(outside, DISCOVERY_DIR, 'SKILL.md'), '# not ours to delete\n');
    symlinkSync(outside, join(home, '.codex', 'skills'), 'dir');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('is not removed through the alias', () => {
    const result = removeUserSkill('codex', home);

    expect(result.action).toBe('failed');
    expect(result.error).toContain('outside');
    expect(existsSync(join(outside, DISCOVERY_DIR, 'SKILL.md'))).toBe(true);
  });

  test('is not written through the alias either', () => {
    const result = writeUserSkill('codex', home);

    expect(result.action).toBe('failed');
    expect(result.error).toContain('outside');
    expect(readFileSync(join(outside, DISCOVERY_DIR, 'SKILL.md'), 'utf8')).toBe(
      '# not ours to delete\n',
    );
  });
});

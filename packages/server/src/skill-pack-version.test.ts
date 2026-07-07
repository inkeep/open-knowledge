import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundledPackVersion,
  computePackUpdateStatus,
  isPackSkillName,
  packIdFromSkillName,
  packUpdateAvailable,
  readBundledPackSkill,
  readSkillVersion,
} from './skill-pack-version.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = join(HERE, '..', 'assets', 'skills', 'packs');
// A real shipped pack so the bundled-source paths are exercised end-to-end.
const SAMPLE_PACK = 'open-knowledge-pack-plain-notes';

describe('pack-name helpers', () => {
  test('isPackSkillName matches only the reserved pack prefix', () => {
    expect(isPackSkillName('open-knowledge-pack-plain-notes')).toBe(true);
    expect(isPackSkillName('open-knowledge')).toBe(false);
    expect(isPackSkillName('my-skill')).toBe(false);
  });
  test('packIdFromSkillName strips the prefix, null for non-pack', () => {
    expect(packIdFromSkillName('open-knowledge-pack-plain-notes')).toBe('plain-notes');
    expect(packIdFromSkillName('my-skill')).toBeNull();
  });
});

describe('readSkillVersion', () => {
  test('reads a string version from frontmatter', () => {
    expect(readSkillVersion('---\nname: x\nversion: "0.18.0"\n---\nbody')).toBe('0.18.0');
  });
  test('undefined when absent / empty / no frontmatter', () => {
    expect(readSkillVersion('---\nname: x\n---\nbody')).toBeUndefined();
    expect(readSkillVersion('---\nname: x\nversion: "  "\n---\nbody')).toBeUndefined();
    expect(readSkillVersion('no frontmatter here')).toBeUndefined();
  });
  test('undefined for a non-string version (we only compare strings)', () => {
    expect(readSkillVersion('---\nname: x\nversion: 18\n---\nbody')).toBeUndefined();
  });
});

describe('packUpdateAvailable (pure verdict)', () => {
  test('versionless installed copy → treated as v0 → update available', () => {
    expect(packUpdateAvailable(undefined, '0.18.0')).toBe(true);
  });
  test('installed older than bundled → update available', () => {
    expect(packUpdateAvailable('0.0.1', '0.18.0')).toBe(true);
    expect(packUpdateAvailable('0.17.9', '0.18.0')).toBe(true);
  });
  test('installed equal to bundled → no update', () => {
    expect(packUpdateAvailable('0.18.0', '0.18.0')).toBe(false);
  });
  test('installed newer than bundled → no update (never offer a downgrade)', () => {
    expect(packUpdateAvailable('999.0.0', '0.18.0')).toBe(false);
    expect(packUpdateAvailable('0.18.1', '0.18.0')).toBe(false);
  });
});

describe('bundled pack source (reads the server bundle; needs a built dist OR source assets)', () => {
  test('readBundledPackSkill returns verbatim content (+ version when stamped)', () => {
    const bundled = readBundledPackSkill(SAMPLE_PACK);
    expect(bundled).not.toBeNull();
    expect(bundled?.content).toContain('name: open-knowledge-pack-plain-notes');
    // Version is present once dist carries the stamp; tolerate an unbuilt/stale
    // dist locally (CI builds before tests) — assert format only when present.
    if (bundled?.version !== undefined) expect(bundled.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  test('null / undefined for non-pack or unknown pack', () => {
    expect(bundledPackVersion('my-skill')).toBeUndefined();
    expect(readBundledPackSkill('my-skill')).toBeNull();
    expect(readBundledPackSkill('open-knowledge-pack-does-not-exist')).toBeNull();
  });
});

describe('computePackUpdateStatus', () => {
  test('non-pack skill → empty (no fields, never badged)', () => {
    expect(computePackUpdateStatus('my-skill', '0.1.0')).toEqual({});
  });
  test('pack with a bundled version → carries bundledVersion + verdict', () => {
    const bundled = bundledPackVersion(SAMPLE_PACK);
    if (bundled === undefined) return; // unbuilt dist locally — covered by the pure verdict tests
    expect(computePackUpdateStatus(SAMPLE_PACK, undefined).updateAvailable).toBe(true);
    expect(computePackUpdateStatus(SAMPLE_PACK, '0.0.1').updateAvailable).toBe(true);
    expect(computePackUpdateStatus(SAMPLE_PACK, bundled).updateAvailable).toBe(false);
    expect(computePackUpdateStatus(SAMPLE_PACK, '999.0.0').updateAvailable).toBe(false);
  });
});

describe('authoring guard: every bundled pack declares a parseable version', () => {
  test('all packs/<id>/SKILL.md carry an x.y.z version', () => {
    expect(existsSync(PACKS_DIR)).toBe(true);
    const packs = readdirSync(PACKS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      const skillMd = join(PACKS_DIR, pack.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue; // a pack may ship folders/templates only
      const version = readSkillVersion(readFileSync(skillMd, 'utf-8'));
      expect(version, `pack "${pack.name}" must declare a version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readAllTargets,
  readServerPackageVersion,
  readSkillInstallStateSnapshot,
  readTargetRecordedAt,
  readTargetVersion,
  skillStateYamlPath,
  writeTargetVersion,
} from './skill-state.ts';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'ok-skill-state-'));
}

describe('readServerPackageVersion', () => {
  test('reads the version field from `@inkeep/open-knowledge-server`/package.json', async () => {
    const version = await readServerPackageVersion();
    expect(typeof version).toBe('string');
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
  });
});

describe('build-time invariant — package.json version matches SKILL.md metadata.version', () => {
  for (const bundle of ['discovery', 'project'] as const) {
    test(`${bundle} bundle SKILL.md metadata.version === server package.json version`, async () => {
      const skillMdUrl = new URL(`../assets/skills/${bundle}/SKILL.md`, import.meta.url);
      const skillMd = await readFile(fileURLToPath(skillMdUrl), 'utf-8');
      const versionMatch = skillMd.match(/^\s*version:\s*"?([^"\n]+)"?\s*$/m);
      expect(versionMatch).not.toBeNull();
      const skillMdVersion = versionMatch?.[1]?.trim();
      const pkgVersion = await readServerPackageVersion();
      expect(skillMdVersion).toBe(pkgVersion);
    });
  }
});

describe('readTargetVersion / writeTargetVersion round-trip (YAML)', () => {
  test('write → read returns the same version', async () => {
    const home = freshHome();
    await writeTargetVersion(home, 'claude-cowork', '1.2.3');
    const read = await readTargetVersion(home, 'claude-cowork');
    expect(read).toBe('1.2.3');
  });

  test('absent file → null', async () => {
    const home = freshHome();
    expect(await readTargetVersion(home, 'claude-cowork')).toBeNull();
    expect(await readTargetVersion(home, 'cli-hosts')).toBeNull();
  });

  test('atomic write — YAML exists at expected path with no .tmp sibling', async () => {
    const home = freshHome();
    await writeTargetVersion(home, 'cli-hosts', '0.1.0');
    const yamlPath = skillStateYamlPath(home);
    const yaml = readFileSync(yamlPath, 'utf-8');
    expect(yaml).toContain('cli-hosts:');
    expect(yaml).toContain('0.1.0');
    expect(yaml).toContain('schema: 1');
    let tmpFound = false;
    for (const f of (await import('node:fs')).readdirSync(dirname(yamlPath))) {
      if (f.startsWith('skill-state.yml.tmp.')) tmpFound = true;
    }
    expect(tmpFound).toBe(false);
  });

  test('writes accept and store an optional surface attribution', async () => {
    const home = freshHome();
    await writeTargetVersion(home, 'claude-cowork', '0.3.0', 'electron-build-and-open');
    await writeTargetVersion(home, 'cli-hosts', '0.3.0', 'cli-npx-skills-add');

    const yaml = readFileSync(skillStateYamlPath(home), 'utf-8');
    expect(yaml).toContain('electron-build-and-open');
    expect(yaml).toContain('cli-npx-skills-add');
  });

  test('all four surface enum values round-trip correctly', async () => {
    const home = freshHome();
    await writeTargetVersion(home, 'claude-cowork', '0.3.0', 'server-build-and-open');
    await writeTargetVersion(home, 'cli-hosts', '0.3.0', 'desktop-direct');
    let yaml = readFileSync(skillStateYamlPath(home), 'utf-8');
    expect(yaml).toContain('server-build-and-open');
    expect(yaml).toContain('desktop-direct');

    await writeTargetVersion(home, 'claude-cowork', '0.4.0', 'electron-build-and-open');
    await writeTargetVersion(home, 'cli-hosts', '0.4.0', 'cli-npx-skills-add');
    yaml = readFileSync(skillStateYamlPath(home), 'utf-8');
    expect(yaml).toContain('electron-build-and-open');
    expect(yaml).toContain('cli-npx-skills-add');
  });

  test('refuses to write invalid version strings', async () => {
    const home = freshHome();
    await expect(writeTargetVersion(home, 'cli-hosts', 'not-a-version')).rejects.toThrow();
    await expect(writeTargetVersion(home, 'cli-hosts', '')).rejects.toThrow();
  });

  test('recordedAt updates on every successful write, including reinstalls of the same version', async () => {
    const home = freshHome();
    await writeTargetVersion(home, 'cli-hosts', '0.3.0');
    const t1 = await readTargetRecordedAt(home, 'cli-hosts');
    expect(t1).not.toBeNull();

    await new Promise((r) => setTimeout(r, 10));

    await writeTargetVersion(home, 'cli-hosts', '0.3.0'); // SAME version
    const t2 = await readTargetRecordedAt(home, 'cli-hosts');
    expect(t2).not.toBeNull();
    expect(new Date(t2 ?? '').getTime()).toBeGreaterThan(new Date(t1 ?? '').getTime());
  });

  test('write to one target preserves another target', async () => {
    const home = freshHome();
    await writeTargetVersion(home, 'claude-cowork', '0.3.0', 'electron-build-and-open');
    await writeTargetVersion(home, 'cli-hosts', '0.3.0', 'cli-npx-skills-add');

    expect(await readTargetVersion(home, 'claude-cowork')).toBe('0.3.0');
    expect(await readTargetVersion(home, 'cli-hosts')).toBe('0.3.0');

    await writeTargetVersion(home, 'cli-hosts', '0.4.0');
    expect(await readTargetVersion(home, 'claude-cowork')).toBe('0.3.0');
    expect(await readTargetVersion(home, 'cli-hosts')).toBe('0.4.0');
  });

  test('write without surface preserves an existing surface on the same target', async () => {
    const home = freshHome();
    await writeTargetVersion(home, 'cli-hosts', '0.3.0', 'cli-npx-skills-add');
    await writeTargetVersion(home, 'cli-hosts', '0.4.0'); // no surface arg

    const yaml = readFileSync(skillStateYamlPath(home), 'utf-8');
    expect(yaml).toContain('0.4.0');
    expect(yaml).toContain('cli-npx-skills-add');
  });
});

describe('readTargetRecordedAt', () => {
  test('returns ISO 8601 in-band timestamp for an existing target', async () => {
    const home = freshHome();
    await writeTargetVersion(home, 'claude-cowork', '0.1.0');
    const ts = await readTargetRecordedAt(home, 'claude-cowork');
    expect(ts).not.toBeNull();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('returns null when the YAML is absent', async () => {
    const home = freshHome();
    expect(await readTargetRecordedAt(home, 'claude-cowork')).toBeNull();
  });
});

describe('fail-soft on bad on-disk content', () => {
  test('schema: 99 → readTargetVersion returns null and warn-log fires', async () => {
    const home = freshHome();
    const yamlPath = skillStateYamlPath(home);
    await mkdir(dirname(yamlPath), { recursive: true });
    await writeFile(yamlPath, 'schema: 99\ntargets: {}\n', 'utf-8');

    const events: Array<{ data: unknown; message: string }> = [];
    const { readSkillStateFile } = await import('./skill-state.ts');
    const state = await readSkillStateFile(home, {
      warn: (data, message) => events.push({ data, message }),
    });
    expect(state).toBeNull();

    expect(await readTargetVersion(home, 'cli-hosts')).toBeNull();
    expect(await readTargetVersion(home, 'claude-cowork')).toBeNull();

    const invalidSchemaEvent = events.find(
      (e) =>
        typeof e.data === 'object' &&
        e.data !== null &&
        (e.data as { event?: unknown }).event === 'skill-state.invalid-schema-version',
    );
    expect(invalidSchemaEvent).toBeDefined();
  });

  test('malformed YAML → readTargetVersion returns null without throwing', async () => {
    const home = freshHome();
    const yamlPath = skillStateYamlPath(home);
    await mkdir(dirname(yamlPath), { recursive: true });
    await writeFile(yamlPath, '{schema: 1, targets:\n  cli-hosts: {version: "0.3.0",\n', 'utf-8');

    expect(await readTargetVersion(home, 'cli-hosts')).toBeNull();
    expect(await readTargetVersion(home, 'claude-cowork')).toBeNull();
  });

  test('schema-violation (non-version-string) → returns null + structured warn', async () => {
    const home = freshHome();
    const yamlPath = skillStateYamlPath(home);
    await mkdir(dirname(yamlPath), { recursive: true });
    await writeFile(
      yamlPath,
      'schema: 1\ntargets:\n  cli-hosts:\n    version: "not-a-semver"\n    recordedAt: "2026-05-05T00:00:00.000Z"\n',
      'utf-8',
    );

    const events: Array<{ data: unknown; message: string }> = [];
    const { readSkillStateFile } = await import('./skill-state.ts');
    const state = await readSkillStateFile(home, {
      warn: (data, message) => events.push({ data, message }),
    });
    expect(state).toBeNull();

    const violationEvent = events.find(
      (e) =>
        typeof e.data === 'object' &&
        e.data !== null &&
        (e.data as { event?: unknown }).event === 'skill-state.schema-violation',
    );
    expect(violationEvent).toBeDefined();
  });
});

describe('readAllTargets / readSkillInstallStateSnapshot', () => {
  test('all-targets resolves null per absent target', async () => {
    const home = freshHome();
    const snapshot = await readAllTargets(home);
    expect(snapshot).toEqual({ 'claude-cowork': null, 'cli-hosts': null });
  });

  test('all-targets resolves recorded entries when the YAML exists', async () => {
    const home = freshHome();
    await writeTargetVersion(home, 'claude-cowork', '1.0.0');
    await writeTargetVersion(home, 'cli-hosts', '0.9.0');
    const snapshot = await readAllTargets(home);
    expect(snapshot['claude-cowork']?.version).toBe('1.0.0');
    expect(snapshot['cli-hosts']?.version).toBe('0.9.0');
    expect(snapshot['claude-cowork']?.recordedAt).toMatch(/^\d{4}-/);
  });

  test('snapshot includes currentVersion + per-target state', async () => {
    const home = freshHome();
    await writeTargetVersion(home, 'claude-cowork', '0.1.0');
    const snapshot = await readSkillInstallStateSnapshot(home);
    expect(snapshot.currentVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(snapshot.targets['claude-cowork']?.version).toBe('0.1.0');
    expect(snapshot.targets['cli-hosts']).toBeNull();
  });
});

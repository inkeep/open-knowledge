/**
 * Unit tests for the shared skill install-state helpers + the build-time
 * version invariant between `@inkeep/open-knowledge-server`'s `package.json`
 * and the bundled SKILL.md frontmatter.
 *
 * On-disk state lives at `~/.ok/skill-state.yml`, replacing the legacy
 * `~/.ok/skill-installed-version` sidecar file (migrated on first
 * encounter).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readAllTargets,
  readBundleDecision,
  readServerPackageVersion,
  readSkillInstallStateSnapshot,
  readTargetRecordedAt,
  readTargetVersion,
  resolveBundleEnabled,
  skillStateYamlPath,
  writeBundleDecision,
  writeTargetVersion,
} from './skill-state.ts';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'ok-skill-state-'));
}

describe('per-bundle opt-in decisions', () => {
  test('resolveBundleEnabled: explicit decision wins; absent grandfathers to disk', () => {
    // Fresh machine (no decision, nothing on disk) — stays uninstalled.
    expect(resolveBundleEnabled(null, { installedOnDisk: false })).toBe(false);
    // Grandfather: existing install with no recorded decision — enabled.
    expect(resolveBundleEnabled(null, { installedOnDisk: true })).toBe(true);
    // Explicit decisions override disk state either way.
    expect(resolveBundleEnabled(true, { installedOnDisk: false })).toBe(true);
    expect(resolveBundleEnabled(false, { installedOnDisk: true })).toBe(false);
  });

  test('readBundleDecision returns null when the file / entry is absent', async () => {
    const home = freshHome();
    expect(await readBundleDecision(home, 'open-knowledge-discovery')).toBeNull();
  });

  test('writeBundleDecision round-trips and preserves other bundles + targets', async () => {
    const home = freshHome();
    // Seed an unrelated target so we can assert it survives the RMW.
    await writeTargetVersion(home, 'cli-hosts', '1.2.3', 'cli-start');

    await writeBundleDecision(home, 'open-knowledge-discovery', true);
    await writeBundleDecision(home, 'open-knowledge-write-skill', false);

    expect(await readBundleDecision(home, 'open-knowledge-discovery')).toBe(true);
    expect(await readBundleDecision(home, 'open-knowledge-write-skill')).toBe(false);
    // The version target is untouched by bundle writes.
    expect(await readTargetVersion(home, 'cli-hosts')).toBe('1.2.3');

    // A later flip of one bundle leaves the other intact.
    await writeBundleDecision(home, 'open-knowledge-discovery', false);
    expect(await readBundleDecision(home, 'open-knowledge-discovery')).toBe(false);
    expect(await readBundleDecision(home, 'open-knowledge-write-skill')).toBe(false);
  });
});

describe('readServerPackageVersion', () => {
  test('reads the version field from `@inkeep/open-knowledge-server`/package.json', async () => {
    const version = await readServerPackageVersion();
    expect(typeof version).toBe('string');
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
  });
});

describe('build-time invariant — package.json version matches SKILL.md metadata.version', () => {
  // Both bundles version in lockstep with the server package.
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
    // Validate the YAML mentions the expected version + target key. The exact
    // serialization shape (indentation, quoting) is yaml@2-implementation-defined;
    // assert content not formatting.
    expect(yaml).toContain('cli-hosts:');
    expect(yaml).toContain('0.1.0');
    expect(yaml).toContain('schema: 1');
    // No leftover tmp file with our randomUUID prefix.
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
    // Use both targets to exercise the full enum across two slots.
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

    // Force a measurable delta; ISO datetime has millisecond precision.
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
    // Surface from the prior write is preserved when caller omits the arg.
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

    // The orchestrator-level entry points fall through to null too.
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
    // Truncated mid-file / nonsense punctuation produces a parse error.
    await writeFile(yamlPath, '{schema: 1, targets:\n  cli-hosts: {version: "0.3.0",\n', 'utf-8');

    // No throw is the contract.
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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { inspectPluginBundleDir } from './registry.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-bundle-inspect-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function skill(dir: string, name: string): void {
  const d = join(dir, 'skills', name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\nbody\n`);
}

function manifest(dir: string, rel: string, body: unknown): void {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, JSON.stringify(body));
}

describe('inspectPluginBundleDir', () => {
  test('detects a Claude plugin repo, enumerates bundled skills + capabilities', () => {
    manifest(root, '.claude-plugin/plugin.json', { name: 'ponytail', version: '4.8.4' });
    skill(root, 'ponytail-audit');
    skill(root, 'ponytail-review');
    mkdirSync(join(root, 'commands'), { recursive: true });
    writeFileSync(join(root, 'commands', 'go.toml'), '');
    writeFileSync(join(root, 'hooks.json'), '{}');

    const got = inspectPluginBundleDir(root);
    expect(got?.provider).toBe('claude');
    expect(got?.plugin).toBe('ponytail');
    expect(got?.version).toBe('4.8.4');
    expect(got?.bundledSkills).toEqual(['ponytail-audit', 'ponytail-review']);
    expect(got?.capabilities).toEqual({
      commands: true,
      hooks: true,
      mcp: false,
      agents: false,
    });
    expect(got?.setupSupported).toBe(true);
  });

  test('reads a single-plugin marketplace.json when plugin.json is absent', () => {
    manifest(root, '.claude-plugin/marketplace.json', {
      name: 'mkt',
      plugins: [{ name: 'ponytail', description: 'lazy', source: './' }],
    });
    skill(root, 'a');
    const got = inspectPluginBundleDir(root);
    expect(got?.plugin).toBe('ponytail');
    expect(got?.description).toBe('lazy');
  });

  test('detects Codex, Gemini, Copilot by their manifests — setup unsupported', () => {
    const codex = mkdtempSync(join(tmpdir(), 'codex-'));
    const gemini = mkdtempSync(join(tmpdir(), 'gemini-'));
    const copilot = mkdtempSync(join(tmpdir(), 'copilot-'));
    try {
      manifest(codex, '.codex-plugin/plugin.json', { name: 'cx', version: '1.0.0' });
      skill(codex, 's');
      manifest(gemini, 'gemini-extension.json', { name: 'gx', version: '2.0.0' });
      skill(gemini, 's');
      // Copilot bare-root plugin.json must declare `skills` to count.
      manifest(copilot, 'plugin.json', { name: 'cp', version: '3.0.0', skills: ['skills/'] });
      skill(copilot, 's');

      expect(inspectPluginBundleDir(codex)).toMatchObject({
        provider: 'codex',
        plugin: 'cx',
        setupSupported: false,
      });
      expect(inspectPluginBundleDir(gemini)).toMatchObject({ provider: 'gemini', plugin: 'gx' });
      expect(inspectPluginBundleDir(copilot)).toMatchObject({ provider: 'copilot', plugin: 'cp' });
    } finally {
      for (const d of [codex, gemini, copilot]) rmSync(d, { recursive: true, force: true });
    }
  });

  test('an unrelated bare-root plugin.json (no skills field) is NOT a Copilot plugin', () => {
    // Common filename — must not false-positive just because a skills/ dir exists.
    manifest(root, 'plugin.json', { name: 'some-random-tool', version: '1.0.0' });
    skill(root, 'a');
    expect(inspectPluginBundleDir(root)).toBeNull();
    // But a Copilot-namespaced manifest IS unambiguous, no skills field needed.
    manifest(root, '.plugin/plugin.json', { name: 'cop' });
    expect(inspectPluginBundleDir(root)).toMatchObject({ provider: 'copilot', plugin: 'cop' });
  });

  test('Claude wins a multi-harness repo (setup provider precedence)', () => {
    manifest(root, '.claude-plugin/plugin.json', { name: 'ponytail' });
    manifest(root, '.codex-plugin/plugin.json', { name: 'ponytail' });
    writeFileSync(join(root, 'gemini-extension.json'), JSON.stringify({ name: 'ponytail' }));
    skill(root, 'a');
    expect(inspectPluginBundleDir(root)?.provider).toBe('claude');
  });

  test('enumerates skills nested under category folders (real plugin layout)', () => {
    // mattpocock/skills-style: skills/<category>/<name>/SKILL.md (depth 2).
    manifest(root, '.claude-plugin/plugin.json', { name: 'mattpocock-skills' });
    for (const [cat, name] of [
      ['productivity', 'grill-me'],
      ['in-progress', 'batch-grill-me'],
      ['misc', 'setup-pre-commit'],
    ] as const) {
      const d = join(root, 'skills', cat, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\n---\nx\n`);
    }
    // A references/ dir under a skill must NOT be mistaken for a sub-skill.
    mkdirSync(join(root, 'skills', 'productivity', 'grill-me', 'references'), { recursive: true });
    writeFileSync(join(root, 'skills', 'productivity', 'grill-me', 'references', 'x.md'), 'ref');

    const got = inspectPluginBundleDir(root);
    expect(got?.plugin).toBe('mattpocock-skills');
    expect(got?.bundledSkills).toEqual(['batch-grill-me', 'grill-me', 'setup-pre-commit']);
  });

  test('null for a bare skill repo (no manifest) and a manifest with no skills/', () => {
    // Bare skill dir, no plugin manifest.
    skill(root, 'lonely');
    expect(inspectPluginBundleDir(root)).toBeNull();
    // Plugin manifest but no skills/ dir → nothing to bundle-offer.
    const noSkills = mkdtempSync(join(tmpdir(), 'noskills-'));
    try {
      manifest(noSkills, '.claude-plugin/plugin.json', { name: 'p' });
      expect(inspectPluginBundleDir(noSkills)).toBeNull();
    } finally {
      rmSync(noSkills, { recursive: true, force: true });
    }
  });
});

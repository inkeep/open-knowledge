import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enumerateAgentPluginsRoot } from './manifest-providers.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-agent-plugins-root-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

function seedPlugin(
  dirName: string,
  manifest: Record<string, unknown> | string,
  skills: string[] = ['probe'],
): void {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'plugin.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
  );
  for (const name of skills) {
    mkdirSync(join(dir, 'skills', name), { recursive: true });
    writeFileSync(
      join(dir, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Does ${name} things\n---\n\nBody.\n`,
    );
  }
}

describe('enumerateAgentPluginsRoot', () => {
  it('surfaces a conformant plugin with plugin provenance and pack identity', () => {
    seedPlugin('ok', {
      $schema: SCHEMA,
      name: 'ok',
      version: '1.2.0',
      description: 'Team skills',
      repository: 'https://github.com/inkeep/open-knowledge',
    });

    const bundles = enumerateAgentPluginsRoot(root, 'agent-plugins', {
      scope: 'project',
      projectPath: '/proj',
    });
    expect(bundles).toHaveLength(1);
    const bundle = bundles[0];
    expect(bundle?.packName).toBe('ok');
    expect(bundle?.packVersion).toBe('1.2.0');
    expect(bundle?.packDescription).toBe('Team skills');
    const skill = bundle?.skills[0];
    expect(skill?.name).toBe('probe');
    expect(skill?.provenance).toMatchObject({
      pluginProvider: 'agent-plugins',
      plugin: 'ok',
      version: '1.2.0',
      repositoryUrl: 'https://github.com/inkeep/open-knowledge',
      scope: 'project',
      projectPath: '/proj',
    });
  });

  it('requires the agent-plugins $schema — a bare name-only manifest is not claimed', () => {
    // The spec forbids component fields in the manifest, so `$schema` is the
    // discriminator; without it a common `plugin.json` filename must not be
    // mislabeled as an Agent Plugin.
    seedPlugin('unclaimed', { name: 'unclaimed' });
    expect(enumerateAgentPluginsRoot(root, 'agent-plugins', { scope: 'user' })).toHaveLength(0);
  });

  it('disqualifies a name that fails the constraint grammar', () => {
    seedPlugin('bad', { $schema: SCHEMA, name: 'Bad--Name.' });
    expect(enumerateAgentPluginsRoot(root, 'agent-plugins', { scope: 'user' })).toHaveLength(0);
  });

  it('skips a skills/ child without SKILL.md but keeps its valid siblings', () => {
    seedPlugin('mixed', { $schema: SCHEMA, name: 'mixed' }, ['good']);
    mkdirSync(join(root, 'mixed', 'skills', 'empty'), { recursive: true });

    const bundles = enumerateAgentPluginsRoot(root, 'agent-plugins', { scope: 'user' });
    expect(bundles[0]?.skills.map((s) => s.name)).toEqual(['good']);
  });

  it('a plugin with no skills contributes nothing (missing locations are non-fatal)', () => {
    seedPlugin('skill-less', { $schema: SCHEMA, name: 'skill-less' }, []);
    expect(enumerateAgentPluginsRoot(root, 'agent-plugins', { scope: 'user' })).toHaveLength(0);
  });

  it('a malformed manifest is skipped without aborting the root', () => {
    seedPlugin('broken', '{not json');
    seedPlugin('fine', { $schema: SCHEMA, name: 'fine' });

    const bundles = enumerateAgentPluginsRoot(root, 'agent-plugins', { scope: 'user' });
    expect(bundles.map((b) => b.packName)).toEqual(['fine']);
  });

  it('a missing root is an empty result, not an error', () => {
    expect(
      enumerateAgentPluginsRoot(join(root, 'nowhere'), 'agent-plugins', { scope: 'user' }),
    ).toHaveLength(0);
  });
});

import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { ConfigSchema } from './schema.ts';
import { getLeafFieldMeta, resolveLeafSchema } from './schema-leaf.ts';

describe('resolveLeafSchema', () => {
  test('does not treat maps or sets as records', () => {
    expect(resolveLeafSchema(z.map(z.string(), z.boolean()), ['key'])).toBeUndefined();
    expect(resolveLeafSchema(z.set(z.boolean()), ['key'])).toBeUndefined();
  });

  test('resolves boolean content-rule entries without inventing leaf metadata', () => {
    const path = ['contentRules', 'okf', 'rules', 'custom-rule'];
    expect(resolveLeafSchema(ConfigSchema, path)?.safeParse(true).success).toBe(true);
    expect(resolveLeafSchema(ConfigSchema, path)?.safeParse('true').success).toBe(false);
    expect(getLeafFieldMeta(ConfigSchema, path)).toBeUndefined();
  });
  test('descends through .default() wrappers to top-level section', () => {
    const leaf = resolveLeafSchema(ConfigSchema, ['content']);
    expect(leaf).toBeDefined();
  });

  test('descends through nested wrappers to a registered scalar leaf', () => {
    const leaf = resolveLeafSchema(ConfigSchema, ['content', 'dir']);
    expect(leaf).toBeDefined();
  });

  test('returns undefined for a missing key in the middle of the path', () => {
    const leaf = resolveLeafSchema(ConfigSchema, ['content', 'nope', 'dir']);
    expect(leaf).toBeUndefined();
  });

  test('returns undefined for a missing top-level key', () => {
    const leaf = resolveLeafSchema(ConfigSchema, ['nonExistentSection']);
    expect(leaf).toBeUndefined();
  });

  test('descends through a record value type to a leaf under an arbitrary key', () => {
    const leaf = resolveLeafSchema(ConfigSchema, ['git', 'hosts', 'ghes.example.com', 'provider']);
    expect(leaf).toBeDefined();
  });

  test('returns undefined for a missing key inside a record value type', () => {
    const leaf = resolveLeafSchema(ConfigSchema, ['git', 'hosts', 'h', 'nope']);
    expect(leaf).toBeUndefined();
  });
});

describe('getLeafFieldMeta', () => {
  test('returns metadata for the project-strict content.dir leaf', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['content', 'dir']);
    expect(meta).toEqual({
      scope: 'project',
      agentSettable: false,
      reload: 'boot',
      defaultScope: 'project',
      description: expect.any(String),
    });
  });

  test('returns metadata for the user-scope appearance.theme leaf', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['appearance', 'theme']);
    expect(meta).toEqual({
      scope: 'user',
      agentSettable: false,
      reload: 'live',
      defaultScope: 'user',
      description: expect.any(String),
    });
  });

  test('returns metadata for the user-scope editor.wordWrap leaf', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['editor', 'wordWrap']);
    expect(meta).toEqual({
      scope: 'user',
      agentSettable: false,
      reload: 'live',
      defaultScope: 'user',
      description: expect.any(String),
    });
  });

  test('returns metadata for the user-scope editor.previewTabs leaf', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['editor', 'previewTabs']);
    expect(meta).toEqual({
      scope: 'user',
      agentSettable: false,
      reload: 'live',
      defaultScope: 'user',
      description: expect.any(String),
    });
  });

  test('returns project-local metadata for the linkPreviews.enabled egress opt-in', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['linkPreviews', 'enabled']);
    expect(meta).toEqual({
      scope: 'project-local',
      agentSettable: false,
      reload: 'live',
      defaultScope: 'project-local',
      description: expect.any(String),
    });
  });

  test('resolves metadata for the project-local autoSync.mode enum leaf (.register before wrappers)', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['autoSync', 'mode']);
    expect(meta).toEqual({
      scope: 'project-local',
      agentSettable: false,
      reload: 'live',
      defaultScope: 'project-local',
      description: expect.any(String),
    });
  });

  test('resolves metadata for the legacy project-local autoSync.enabled leaf', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['autoSync', 'enabled']);
    expect(meta).toEqual({
      scope: 'project-local',
      agentSettable: false,
      reload: 'live',
      defaultScope: 'project-local',
      description: expect.any(String),
    });
  });

  test('resolves metadata for the project-local terminal.shell leaf', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['terminal', 'shell']);
    expect(meta).toEqual({
      scope: 'project-local',
      agentSettable: false,
      reload: 'live',
      defaultScope: 'project-local',
      description: expect.any(String),
    });
  });

  test('resolves metadata for the committed autoSync.default union leaf (.register before wrappers)', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['autoSync', 'default']);
    expect(meta).toEqual({
      scope: 'project',
      agentSettable: false,
      reload: 'live',
      defaultScope: 'project',
      description: expect.any(String),
    });
  });

  test('resolves user metadata for a git.hosts.<host>.provider leaf behind a record', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['git', 'hosts', 'ghes.example.com', 'provider']);
    expect(meta).toEqual({
      scope: 'user',
      agentSettable: false,
      reload: 'boot',
      defaultScope: 'user',
      description: expect.any(String),
    });
  });

  test('returns undefined for an unknown leaf inside a record value type', () => {
    expect(getLeafFieldMeta(ConfigSchema, ['git', 'hosts', 'h', 'nope'])).toBeUndefined();
  });

  test('returns undefined for an unresolved path', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['content', 'nonexistent']);
    expect(meta).toBeUndefined();
  });

  test('returns undefined for a non-leaf intermediate (object container without registered metadata)', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['appearance']);
    expect(meta).toBeUndefined();
  });
});

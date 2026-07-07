import { describe, expect, test } from 'bun:test';
import { ConfigSchema } from './schema.ts';
import { getLeafFieldMeta, resolveLeafSchema } from './schema-leaf.ts';

describe('resolveLeafSchema', () => {
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

  // `folders` array leaf was removed. The
  // resolveLeafSchema implementation still needs to handle missing keys
  // (covered by 'returns undefined for a missing top-level key' above).
});

describe('getLeafFieldMeta', () => {
  test('returns metadata for the project-strict content.dir leaf', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['content', 'dir']);
    expect(meta).toEqual({
      scope: 'project',
      agentSettable: false,
      defaultScope: 'project',
      description: expect.any(String),
    });
  });

  test('returns metadata for the user-scope appearance.theme leaf', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['appearance', 'theme']);
    expect(meta).toEqual({
      scope: 'user',
      agentSettable: false,
      defaultScope: 'user',
      description: expect.any(String),
    });
  });

  test('returns metadata for the user-scope editor.wordWrap leaf', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['editor', 'wordWrap']);
    expect(meta).toEqual({
      scope: 'user',
      agentSettable: false,
      defaultScope: 'user',
      description: expect.any(String),
    });
  });

  test('returns undefined for an unresolved path', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['content', 'nonexistent']);
    expect(meta).toBeUndefined();
  });

  test('returns undefined for a non-leaf intermediate (object container without registered metadata)', () => {
    // `appearance` is a container; its inner shape carries no fieldRegistry entry.
    const meta = getLeafFieldMeta(ConfigSchema, ['appearance']);
    expect(meta).toBeUndefined();
  });
});

import { describe, expect, test } from 'bun:test';
import { ConfigSchema } from './schema';

describe('ConfigSchema', () => {
  test('empty object returns all defaults', () => {
    const config = ConfigSchema.parse({});
    expect(config.content.dir).toBe('.');
    expect(config.appearance.theme).toBeUndefined();
    expect(config.editor.wordWrap).toBe(true);
    expect(config.autoSync.enabled).toBeNull();
    expect(config.terminal.enabled).toBeNull();
  });

  test('stale dropped fields pass loose-mode without throwing', () => {
    const result = ConfigSchema.safeParse({
      sync: { pushIntervalSeconds: 30, autoCommit: true },
      persistence: { debounceMs: 2000 },
      server: { port: 3000, host: 'example.dev', openOnAgentEdit: true },
      github: { oauthAppClientId: 'custom' },
      mcp: { autoStart: false, tools: { search: { maxResults: 100 } } },
    });
    expect(result.success).toBe(true);
  });

  test('appearance.theme accepts the enum values', () => {
    for (const theme of ['light', 'dark', 'system'] as const) {
      const config = ConfigSchema.parse({ appearance: { theme } });
      expect(config.appearance.theme).toBe(theme);
    }
  });

  test('appearance.theme rejects values outside the enum', () => {
    const result = ConfigSchema.safeParse({ appearance: { theme: 'midnight' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('theme');
    }
  });

  test('editor.wordWrap accepts boolean values', () => {
    for (const wordWrap of [true, false] as const) {
      const config = ConfigSchema.parse({ editor: { wordWrap } });
      expect(config.editor.wordWrap).toBe(wordWrap);
    }
  });

  test('editor.wordWrap rejects non-boolean values', () => {
    const result = ConfigSchema.safeParse({ editor: { wordWrap: 'false' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('wordWrap');
    }
  });

  test('content.include and content.exclude pass loose-mode (removed from schema)', () => {
    const result = ConfigSchema.safeParse({
      content: { include: ['**/*.md'], exclude: ['drafts/**'] },
    });
    expect(result.success).toBe(true);
  });

  test('content.dir is preserved', () => {
    const config = ConfigSchema.parse({
      content: { dir: 'docs' },
    });
    expect(config.content.dir).toBe('docs');
  });


});

describe('ConfigSchema (upload surface removed per 2026-04-24 amendment)', () => {
  test('legacy upload.* keys parse cleanly without throwing', () => {
    const legacyInput: unknown = {
      upload: {
        attachmentFolderPath: 'attachments',
        emitFormat: 'markdown-image',
        maxBytes: 104857600,
        dedup: { mode: 'off', ui: 'silent' },
        wikiEmbedExtensions: ['png', 'pdf'],
      },
    };
    expect(() => ConfigSchema.parse(legacyInput)).not.toThrow();
  });
});

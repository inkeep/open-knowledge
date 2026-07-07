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
    // The schema is `z.looseObject` so existing configs carrying removed
    // keys (sync.*, persistence.*, server.port, plus the recently-removed
    // either-scope fields whose values now live as constants in core) parse
    // cleanly; users mid-upgrade aren't broken. The loader emits a
    // deprecation warn for the recently-removed keys; the codemod
    // (`ok config migrate`) is the proactive cleanup path.
    const result = ConfigSchema.safeParse({
      sync: { pushIntervalSeconds: 30, autoCommit: true },
      persistence: { debounceMs: 2000 },
      server: { port: 3000, host: 'example.dev', openOnAgentEdit: true },
      github: { oauthAppClientId: 'custom' },
      mcp: { autoStart: false, tools: { search: { maxResults: 100 } } },
    });
    expect(result.success).toBe(true);
  });

  test('legacy autoSync.onboardingResolvedAt key parses via looseObject without error', () => {
    // The explicit `onboardingResolvedAt` field declaration was dropped;
    // looseObject semantics still admit the legacy key so hand-edited configs
    // in the wild don't reject. The key is silently ignored — no current
    // reader consumes it.
    const result = ConfigSchema.safeParse({
      autoSync: { onboardingResolvedAt: '2026-04-29T00:00:00.000Z' },
    });
    expect(result.success).toBe(true);
  });

  test('autoSync.enabled accepts boolean true / false / null', () => {
    for (const enabled of [true, false, null] as const) {
      const config = ConfigSchema.parse({ autoSync: { enabled } });
      expect(config.autoSync.enabled).toBe(enabled);
    }
  });

  test('autoSync.enabled rejects non-boolean values', () => {
    const result = ConfigSchema.safeParse({ autoSync: { enabled: 'true' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('enabled');
    }
  });

  test('terminal.enabled accepts boolean true / false / null', () => {
    for (const enabled of [true, false, null] as const) {
      const config = ConfigSchema.parse({ terminal: { enabled } });
      expect(config.terminal.enabled).toBe(enabled);
    }
  });

  test('terminal.enabled rejects non-boolean values', () => {
    const result = ConfigSchema.safeParse({ terminal: { enabled: 'true' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('enabled');
    }
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
    // `content.include` / `content.exclude` were removed from `ConfigSchema`;
    // path rules now live in `.okignore` files. Existing keys parse silently
    // via `z.looseObject` so existing configs don't crash; the loader's
    // REMOVED_KEY check rejects them at the YAML layer with a migration hint.
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

  // `preview.*` is no longer a schema section — the preview iframe runs a fixed
  // open network CSP (not configurable). A stale `preview.scriptSrc` /
  // `preview.baseUrl` is rejected via REMOVED_KEYS (see core's removed-keys).

  // `folders` was removed from ConfigSchema. Folder defaults
  // live in nested `<folder>/.ok/frontmatter.yml` files; the FolderRuleSchema
  // export remains for set_folder_rule's helper shapes, but it no longer
  // corresponds to a top-level config field.
  // Loose-mode behavior on unknown top-level keys is covered separately.
});

describe('ConfigSchema (upload surface removed per 2026-04-24 amendment)', () => {
  test('legacy upload.* keys parse cleanly without throwing', () => {
    // The `upload.*` user-facing config surface was removed entirely
    // (zero user-facing upload config; all values are
    // module-level constants in `@inkeep/open-knowledge-core`). Legacy
    // configs still carrying any `upload.*` shape parse cleanly because the
    // schema is `z.looseObject` — unknown
    // keys are preserved on the parsed result rather than stripped, but
    // they are not consumed by any code that reads the schema. The
    // `loader.ts` deprecation WARN surfaces them at load time so users
    // notice the dead config. The input is typed as `unknown` rather than
    // the Zod-inferred shape because the point of the test is to exercise
    // legacy-key acceptance.
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

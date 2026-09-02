import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { SUPPORTED_LOCALES } from '../i18n/locales.ts';
import {
  ConfigSchema,
  checkEmbeddingsBaseUrl,
  isValidAttachmentFolderPath,
  normalizeAttachmentFolderPath,
} from './schema.ts';
import { getLeafFieldMeta } from './schema-leaf.ts';

describe('checkEmbeddingsBaseUrl', () => {
  test('accepts https endpoints', () => {
    expect(checkEmbeddingsBaseUrl('https://api.openai.com/v1')).toBeNull();
    expect(checkEmbeddingsBaseUrl('https://azure.example.com/openai/v1/')).toBeNull();
    expect(checkEmbeddingsBaseUrl('https://api.example.com')).toBeNull();
  });

  test('accepts http only for loopback hosts (key never leaves the machine)', () => {
    expect(checkEmbeddingsBaseUrl('http://localhost:11434/v1')).toBeNull();
    expect(checkEmbeddingsBaseUrl('http://127.0.0.1:8080/v1')).toBeNull();
    expect(checkEmbeddingsBaseUrl('http://[::1]:1234/v1')).toBeNull();
  });

  test('rejects plaintext http to a non-loopback host', () => {
    expect(checkEmbeddingsBaseUrl('http://evil.example/v1')).toBe('insecure-scheme');
    expect(checkEmbeddingsBaseUrl('http://api.openai.com/v1')).toBe('insecure-scheme');
  });

  test('rejects non-http(s) schemes', () => {
    expect(checkEmbeddingsBaseUrl('ftp://api.example.com')).toBe('insecure-scheme');
    expect(checkEmbeddingsBaseUrl('file:///etc/passwd')).toBe('insecure-scheme');
  });

  test('rejects unparseable input', () => {
    expect(checkEmbeddingsBaseUrl('not a url')).toBe('invalid-url');
    expect(checkEmbeddingsBaseUrl('api.openai.com/v1')).toBe('invalid-url');
    expect(checkEmbeddingsBaseUrl('')).toBe('invalid-url');
  });
});

describe('content.attachmentFolderPath', () => {
  test('defaults to "./" when absent', () => {
    expect(ConfigSchema.parse({}).content.attachmentFolderPath).toBe('./');
  });

  test('defaults to "./" when key is absent inside content', () => {
    expect(ConfigSchema.parse({ content: { dir: 'docs' } }).content.attachmentFolderPath).toBe(
      './',
    );
  });

  test('accepts "./" (colocated with current document)', () => {
    expect(
      ConfigSchema.parse({ content: { attachmentFolderPath: './' } }).content.attachmentFolderPath,
    ).toBe('./');
  });

  test('accepts "/" (content-root sentinel)', () => {
    expect(
      ConfigSchema.parse({ content: { attachmentFolderPath: '/' } }).content.attachmentFolderPath,
    ).toBe('/');
  });

  test('accepts "./attachments" (subfolder under current document folder)', () => {
    expect(
      ConfigSchema.parse({ content: { attachmentFolderPath: './attachments' } }).content
        .attachmentFolderPath,
    ).toBe('./attachments');
  });

  test('accepts "attachments" (fixed folder under content root)', () => {
    expect(
      ConfigSchema.parse({ content: { attachmentFolderPath: 'attachments' } }).content
        .attachmentFolderPath,
    ).toBe('attachments');
  });

  test('accepts "assets/uploads" (nested path under content root)', () => {
    expect(
      ConfigSchema.parse({ content: { attachmentFolderPath: 'assets/uploads' } }).content
        .attachmentFolderPath,
    ).toBe('assets/uploads');
  });

  test('normalizes empty string to "./"', () => {
    expect(normalizeAttachmentFolderPath('')).toBe('./');
    expect(isValidAttachmentFolderPath('')).toBe(true);
  });

  test('normalizes whitespace-only to "./"', () => {
    expect(normalizeAttachmentFolderPath('   ')).toBe('./');
    expect(isValidAttachmentFolderPath('   ')).toBe(true);
  });

  test('rejects ".." traversal segment', () => {
    expect(() => ConfigSchema.parse({ content: { attachmentFolderPath: '..' } })).toThrow();
  });

  test('rejects "../escape" traversal', () => {
    expect(() => ConfigSchema.parse({ content: { attachmentFolderPath: '../escape' } })).toThrow();
  });

  test('rejects nested traversal "good/../../../etc"', () => {
    expect(() =>
      ConfigSchema.parse({ content: { attachmentFolderPath: 'good/../../../etc' } }),
    ).toThrow();
  });

  test('rejects NUL byte', () => {
    expect(() =>
      ConfigSchema.parse({ content: { attachmentFolderPath: 'attach\0ments' } }),
    ).toThrow();
  });

  test('rejects backslash', () => {
    expect(() =>
      ConfigSchema.parse({ content: { attachmentFolderPath: 'attach\\ments' } }),
    ).toThrow();
  });

  test('rejects absolute POSIX path "/etc/passwd"', () => {
    expect(() =>
      ConfigSchema.parse({ content: { attachmentFolderPath: '/etc/passwd' } }),
    ).toThrow();
  });

  test('rejects absolute POSIX path "/attachments"', () => {
    expect(() =>
      ConfigSchema.parse({ content: { attachmentFolderPath: '/attachments' } }),
    ).toThrow();
  });

  test('rejects Windows drive-letter path "C:/"', () => {
    expect(() => ConfigSchema.parse({ content: { attachmentFolderPath: 'C:/' } })).toThrow();
  });

  test('rejects Windows drive-letter path "D:attachments"', () => {
    expect(() =>
      ConfigSchema.parse({ content: { attachmentFolderPath: 'D:attachments' } }),
    ).toThrow();
  });
});

describe('appearance.sidebar view toggles', () => {
  test('sidebar defaults: hidden files off, only-markdown off, Skills section on, .ok folders off, grouping on', () => {
    const sidebar = ConfigSchema.parse({ appearance: { sidebar: {} } }).appearance.sidebar;
    expect(sidebar).toEqual({
      showHiddenFiles: false,
      showOnlyMarkdownFiles: false,
      showSkillsSection: true,
      showOkFolders: false,
      showSkillGroups: true,
      pinnedProjectSkills: [],
      pinnedGlobalSkills: [],
    });
  });

  test('explicit values override every toggle default', () => {
    const sidebar = ConfigSchema.parse({
      appearance: {
        sidebar: {
          showHiddenFiles: true,
          showOnlyMarkdownFiles: true,
          showSkillsSection: false,
          showOkFolders: true,
          showSkillGroups: false,
          pinnedProjectSkills: ['mine'],
          pinnedGlobalSkills: ['ponytail'],
        },
      },
    }).appearance.sidebar;
    expect(sidebar).toEqual({
      showHiddenFiles: true,
      showOnlyMarkdownFiles: true,
      showSkillsSection: false,
      showOkFolders: true,
      showSkillGroups: false,
      pinnedProjectSkills: ['mine'],
      pinnedGlobalSkills: ['ponytail'],
    });
  });
});

describe('appearance.language', () => {
  test('accepts every enumerated locale plus the system sentinel', () => {
    for (const locale of [...SUPPORTED_LOCALES, 'system']) {
      const parsed = ConfigSchema.parse({ appearance: { language: locale } });
      expect(parsed.appearance.language).toBe(locale);
    }
  });

  test('rejects a language with no catalog behind it', () => {
    const result = ConfigSchema.safeParse({ appearance: { language: 'ja' } });
    expect(result.success).toBe(false);
  });

  test('is absent rather than defaulted when unset', () => {
    expect(ConfigSchema.parse({}).appearance.language).toBeUndefined();
  });
});

describe('editor preferences', () => {
  test('preview tabs default on and preserve an explicit opt-out', () => {
    expect(ConfigSchema.parse({}).editor.previewTabs).toBe(true);
    expect(ConfigSchema.parse({ editor: { previewTabs: false } }).editor.previewTabs).toBe(false);
  });
});

describe('linkPreviews.enabled (external link-hover preview egress default)', () => {
  test('defaults to enabled when the block is absent', () => {
    expect(ConfigSchema.parse({}).linkPreviews).toEqual({ enabled: true });
  });

  test('defaults enabled to true when linkPreviews is present but enabled is absent', () => {
    expect(ConfigSchema.parse({ linkPreviews: {} }).linkPreviews.enabled).toBe(true);
  });

  test('accepts an explicit opt-out', () => {
    expect(ConfigSchema.parse({ linkPreviews: { enabled: false } }).linkPreviews.enabled).toBe(
      false,
    );
  });

  test('accepts an explicit opt-in', () => {
    expect(ConfigSchema.parse({ linkPreviews: { enabled: true } }).linkPreviews.enabled).toBe(true);
  });
});

describe('slides.enabled (Slides plugin toggle default)', () => {
  test('resolves to disabled when the section is absent', () => {
    expect(ConfigSchema.parse({}).slides).toEqual({ enabled: false });
  });

  test('defaults enabled to false when slides is present but enabled is absent', () => {
    expect(ConfigSchema.parse({ slides: {} }).slides.enabled).toBe(false);
  });

  test('accepts an explicit opt-in', () => {
    expect(ConfigSchema.parse({ slides: { enabled: true } }).slides.enabled).toBe(true);
  });

  test('accepts an explicit opt-out', () => {
    expect(ConfigSchema.parse({ slides: { enabled: false } }).slides.enabled).toBe(false);
  });
});

describe('legacy upload.* keys remain non-authoritative', () => {
  test('upload.* keys pass through looseObject without schema error', () => {
    const result = ConfigSchema.safeParse({
      upload: { attachmentFolder: 'attachments', maxSize: 10485760 },
    });
    expect(result.success).toBe(true);
  });
});

describe('contentRules forward compatibility', () => {
  test('an unknown plugin slice survives parse instead of being stripped', () => {
    const parsed = ConfigSchema.parse({
      contentRules: { 'future-linter': { enabled: true, level: 'strict' } },
    });
    expect(parsed.contentRules['future-linter']).toEqual({
      enabled: true,
      level: 'strict',
    });
    expect(parsed.contentRules.markdownlint).toEqual({ enabled: false });
  });
});

describe('autoSync.mode (canonical per-machine sync knob)', () => {
  test('defaults to null (unanswered) when the whole block is absent', () => {
    expect(ConfigSchema.parse({}).autoSync).toEqual({ mode: null, enabled: null, default: null });
  });

  test('accepts each sync mode', () => {
    for (const mode of ['off', 'pull', 'full'] as const) {
      expect(ConfigSchema.parse({ autoSync: { mode } }).autoSync.mode).toBe(mode);
    }
  });

  test('accepts an explicit null', () => {
    expect(ConfigSchema.parse({ autoSync: { mode: null } }).autoSync.mode).toBeNull();
  });

  test('rejects a value outside the mode vocabulary', () => {
    expect(ConfigSchema.safeParse({ autoSync: { mode: 'sideways' } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ autoSync: { mode: true } }).success).toBe(false);
  });

  test('the legacy enabled boolean still parses (derived to a mode only at read time)', () => {
    expect(ConfigSchema.parse({ autoSync: { enabled: true } }).autoSync.enabled).toBe(true);
    expect(ConfigSchema.parse({ autoSync: { enabled: false } }).autoSync.enabled).toBe(false);
    expect(ConfigSchema.parse({ autoSync: { enabled: null } }).autoSync.enabled).toBeNull();
  });
});

describe('autoSync.default (committed seed widened to the mode vocabulary)', () => {
  test('accepts the mode strings', () => {
    for (const mode of ['off', 'pull', 'full'] as const) {
      expect(ConfigSchema.parse({ autoSync: { default: mode } }).autoSync.default).toBe(mode);
    }
  });

  test('still accepts the legacy boolean seed', () => {
    expect(ConfigSchema.parse({ autoSync: { default: true } }).autoSync.default).toBe(true);
    expect(ConfigSchema.parse({ autoSync: { default: false } }).autoSync.default).toBe(false);
  });

  test('accepts an explicit null (ask)', () => {
    expect(ConfigSchema.parse({ autoSync: { default: null } }).autoSync.default).toBeNull();
  });

  test('rejects a value outside the boolean|mode union', () => {
    expect(ConfigSchema.safeParse({ autoSync: { default: 'sideways' } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ autoSync: { default: 3 } }).success).toBe(false);
  });
});

describe('autoSync forward/backward compatibility (looseObject round-trip)', () => {
  test('unknown autoSync sub-keys survive parse instead of being stripped', () => {
    const parsed = ConfigSchema.parse({
      autoSync: { mode: 'pull', onboardingResolvedAt: '2026-01-01', inheritedFrom: 'root' },
    });
    expect(parsed.autoSync.mode).toBe('pull');
    expect((parsed.autoSync as Record<string, unknown>).onboardingResolvedAt).toBe('2026-01-01');
    expect((parsed.autoSync as Record<string, unknown>).inheritedFrom).toBe('root');
  });

  test('an older mode-unaware schema reads a mode-only config as sync-off, never pushing', () => {
    const legacyAutoSync = z
      .looseObject({
        enabled: z.boolean().nullable().default(null),
        default: z.boolean().nullable().default(null),
      })
      .default({ enabled: null, default: null });
    const legacySchema = z.looseObject({ autoSync: legacyAutoSync });

    const parsed = legacySchema.parse({ autoSync: { mode: 'pull' } });
    expect((parsed.autoSync as Record<string, unknown>).mode).toBe('pull');
    expect(parsed.autoSync.enabled).toBeNull();
    expect(parsed.autoSync.default).toBeNull();

    const legacyBootResolvesEnabled =
      parsed.autoSync.enabled !== null && parsed.autoSync.enabled !== undefined
        ? parsed.autoSync.enabled === true
        : parsed.autoSync.default === true;
    expect(legacyBootResolvesEnabled).toBe(false);
  });

  test('a committed default:"pull" fails an older schema wholesale — the accepted skew cost', () => {
    const legacyAutoSync = z
      .looseObject({
        enabled: z.boolean().nullable().default(null),
        default: z.boolean().nullable().default(null),
      })
      .default({ enabled: null, default: null });
    const legacySchema = z.looseObject({ autoSync: legacyAutoSync });

    expect(legacySchema.safeParse({ autoSync: { mode: 'pull' } }).success).toBe(true);
    expect(legacySchema.safeParse({ autoSync: { default: 'pull' } }).success).toBe(false);

    const legacyDefaults = legacySchema.parse({});
    expect(legacyDefaults.autoSync.default).toBeNull();
  });
});

describe('server.* (canonical listener/exposure surface)', () => {
  test('defaults: loopback-only bind, consent off, everything else unset', () => {
    const config = ConfigSchema.parse({});
    expect(config.server.bind).toEqual(['127.0.0.1']);
    expect(config.server.allowExternal).toBe(false);
    expect(config.server.port).toBeUndefined();
    expect(config.server.externalUrl).toBeUndefined();
    expect(config.server.openBrowser).toBeUndefined();
    expect(config.server.idleShutdown).toBeUndefined();
  });

  test('port accepts the valid range and rejects out-of-range or fractional values', () => {
    expect(ConfigSchema.parse({ server: { port: 8080 } }).server.port).toBe(8080);
    expect(ConfigSchema.safeParse({ server: { port: 0 } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ server: { port: 65536 } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ server: { port: 80.5 } }).success).toBe(false);
  });

  test('bind is a non-empty list of non-empty addresses', () => {
    expect(ConfigSchema.parse({ server: { bind: ['0.0.0.0'] } }).server.bind).toEqual(['0.0.0.0']);
    expect(ConfigSchema.parse({ server: { bind: ['127.0.0.1', '::1'] } }).server.bind).toEqual([
      '127.0.0.1',
      '::1',
    ]);
    expect(ConfigSchema.safeParse({ server: { bind: [] } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ server: { bind: [''] } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ server: { bind: '127.0.0.1' } }).success).toBe(false);
  });

  test('bind is registered project-local so a committed value is ignored (clone-safety)', () => {
    const meta = getLeafFieldMeta(ConfigSchema, ['server', 'bind']);
    expect(meta?.scope).toBe('project-local');
    expect(meta?.defaultScope).toBe('project-local');
  });

  test('externalUrl accepts http(s) URLs and rejects other schemes or non-URLs', () => {
    expect(
      ConfigSchema.parse({ server: { externalUrl: 'https://kb.example.com' } }).server.externalUrl,
    ).toBe('https://kb.example.com');
    expect(
      ConfigSchema.parse({ server: { externalUrl: 'http://localhost:8080' } }).server.externalUrl,
    ).toBe('http://localhost:8080');
    expect(ConfigSchema.safeParse({ server: { externalUrl: 'not a url' } }).success).toBe(false);
    expect(
      ConfigSchema.safeParse({ server: { externalUrl: 'ftp://kb.example.com' } }).success,
    ).toBe(false);
  });

  test("idleShutdown accepts 'off' and s/m/h durations, rejects bare numbers and other units", () => {
    for (const good of ['off', '90s', '30m', '2h']) {
      expect(ConfigSchema.parse({ server: { idleShutdown: good } }).server.idleShutdown).toBe(good);
    }
    for (const bad of ['30', '0m', '1d', 'never', '']) {
      expect(ConfigSchema.safeParse({ server: { idleShutdown: bad } }).success).toBe(false);
    }
  });
});

describe('search.semantic embedding transport tuning', () => {
  test('accepts positive integer overrides and keeps the legacy defaults when absent', () => {
    const configured = ConfigSchema.parse({
      search: {
        semantic: {
          maxBatchSize: 2,
          maxBatchChars: 16_000,
          docTimeoutMs: 120_000,
        },
      },
    }).search.semantic;
    expect(configured.maxBatchSize).toBe(2);
    expect(configured.maxBatchChars).toBe(16_000);
    expect(configured.docTimeoutMs).toBe(120_000);

    const defaults = ConfigSchema.parse({}).search.semantic;
    expect(defaults.maxBatchSize).toBe(96);
    expect(defaults.maxBatchChars).toBe(96_000);
    expect(defaults.docTimeoutMs).toBe(30_000);
  });

  test.each([
    'maxBatchSize',
    'maxBatchChars',
    'docTimeoutMs',
  ] as const)('%s rejects zero, negative, fractional, and string values', (field) => {
    for (const invalid of [0, -1, 1.5, '2']) {
      expect(ConfigSchema.safeParse({ search: { semantic: { [field]: invalid } } }).success).toBe(
        false,
      );
    }
  });

  test.each([
    'maxBatchSize',
    'maxBatchChars',
    'docTimeoutMs',
  ] as const)('%s is project-local, non-agent-settable, and live-reloaded', (field) => {
    expect(getLeafFieldMeta(ConfigSchema, ['search', 'semantic', field])).toMatchObject({
      scope: 'project-local',
      defaultScope: 'project-local',
      agentSettable: false,
      reload: 'live',
    });
  });
});

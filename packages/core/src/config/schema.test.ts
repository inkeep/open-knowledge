import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { SUPPORTED_LOCALES } from '../i18n/locales.ts';
import {
  ConfigSchema,
  checkEmbeddingsBaseUrl,
  isValidAttachmentFolderPath,
  normalizeAttachmentFolderPath,
} from './schema.ts';

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
  test('sidebar defaults: hidden files off, only-markdown off, Skills section on, .ok folders off', () => {
    const sidebar = ConfigSchema.parse({ appearance: { sidebar: {} } }).appearance.sidebar;
    expect(sidebar).toEqual({
      showHiddenFiles: false,
      showOnlyMarkdownFiles: false,
      showSkillsSection: true,
      showOkFolders: false,
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
        },
      },
    }).appearance.sidebar;
    expect(sidebar).toEqual({
      showHiddenFiles: true,
      showOnlyMarkdownFiles: true,
      showSkillsSection: false,
      showOkFolders: true,
    });
  });
});

describe('appearance.language', () => {
  test('accepts every enumerated locale plus the system sentinel', () => {
    // Enumerating the core tuple rather than a hand-written list is the point:
    // a leaf that re-declared its own tags would drift the moment a locale is
    // added, and a user's stored language would stop parsing.
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
    // No `.default('system')`: an unset language and an explicit 'system' both
    // follow the OS, so writing a default would only add a config key nobody
    // asked for. Mirrors `appearance.theme`.
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
    // A NEWER OK version's plugin config (a direct child of `contentRules`) must
    // round-trip through an older version's parse→write-back cycle, not silently
    // disappear.
    const parsed = ConfigSchema.parse({
      contentRules: { 'future-linter': { enabled: true, level: 'strict' } },
    });
    expect(parsed.contentRules['future-linter']).toEqual({
      enabled: true,
      level: 'strict',
    });
    // The known slice still defaults alongside the unknown one (off by default).
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
    // looseObject retains keys the schema doesn't model (worktree-inherit flags,
    // legacy onboarding stamps) so they round-trip on write-back.
    expect((parsed.autoSync as Record<string, unknown>).onboardingResolvedAt).toBe('2026-01-01');
    expect((parsed.autoSync as Record<string, unknown>).inheritedFrom).toBe('root');
  });

  test('an older mode-unaware schema reads a mode-only config as sync-off, never pushing', () => {
    // A newer OK can write autoSync.mode into a config an older OK never learned
    // about. The old schema (mode-unaware, enabled-only) must read that config as
    // UNANSWERED and never silently enable push. Snapshot the pre-change schema +
    // boot resolution so the guarantee is pinned even after the real schema moves.
    const legacyAutoSync = z
      .looseObject({
        enabled: z.boolean().nullable().default(null),
        default: z.boolean().nullable().default(null),
      })
      .default({ enabled: null, default: null });
    const legacySchema = z.looseObject({ autoSync: legacyAutoSync });

    const parsed = legacySchema.parse({ autoSync: { mode: 'pull' } });
    // The mode key is preserved (looseObject) but invisible to the old schema.
    expect((parsed.autoSync as Record<string, unknown>).mode).toBe('pull');
    expect(parsed.autoSync.enabled).toBeNull();
    expect(parsed.autoSync.default).toBeNull();

    // Pre-change boot resolution: per-machine enabled wins, else committed
    // default === true. With both null, sync is OFF and the engine never pushes.
    const legacyBootResolvesEnabled =
      parsed.autoSync.enabled !== null && parsed.autoSync.enabled !== undefined
        ? parsed.autoSync.enabled === true
        : parsed.autoSync.default === true;
    expect(legacyBootResolvesEnabled).toBe(false);
  });

  test('a committed default:"pull" fails an older schema wholesale — the accepted skew cost', () => {
    // `autoSync.mode` and `autoSync.default` have OPPOSITE forward-compat
    // profiles. `mode` is a NEW key an old looseObject passes through silently;
    // `default` is a KNOWN, type-checked leaf (boolean-only in the old schema),
    // so a committed default:'pull' is rejected — and because it's a leaf of the
    // whole config, that failure fails the ENTIRE parse, so a mode-unaware app
    // boots on schema defaults for that file. This whole-config reset is the
    // deliberately-accepted cost of the single-knob config design: the
    // no-silent-push guarantee still holds (the fallback default is null → off),
    // and the residual is that a skewed collaborator falls back to defaults
    // until they update. Pin the asymmetry so the two keys stay documented.
    const legacyAutoSync = z
      .looseObject({
        enabled: z.boolean().nullable().default(null),
        default: z.boolean().nullable().default(null),
      })
      .default({ enabled: null, default: null });
    const legacySchema = z.looseObject({ autoSync: legacyAutoSync });

    // The new `mode` key parses cleanly via looseObject (invisible to the old
    // schema)...
    expect(legacySchema.safeParse({ autoSync: { mode: 'pull' } }).success).toBe(true);
    // ...but a committed `default: 'pull'` is rejected, failing the whole parse.
    expect(legacySchema.safeParse({ autoSync: { default: 'pull' } }).success).toBe(false);

    // The all-defaults fallback a rejecting app boots on has `default: null`, so
    // boot resolution is OFF — no silent push on the skewed version.
    const legacyDefaults = legacySchema.parse({});
    expect(legacyDefaults.autoSync.default).toBeNull();
  });
});

describe('server.* (canonical listener/exposure surface)', () => {
  test('defaults: loopback-only bind, consent off, everything else unset', () => {
    const config = ConfigSchema.parse({});
    expect(config.server.bind).toEqual(['127.0.0.1']);
    expect(config.server.allowExternal).toBe(false);
    // No schema default: unset means dynamic locally / platform PORT env in
    // images, and keeps the remote.port alias-read detectable.
    expect(config.server.port).toBeUndefined();
    expect(config.server.externalUrl).toBeUndefined();
    // Derived defaults resolve in resolveServerRuntimeConfig, not here.
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

  test('the deprecated publicUrl spelling still validates with the same URL shape', () => {
    expect(
      ConfigSchema.parse({ server: { publicUrl: 'https://kb.example.com' } }).server.publicUrl,
    ).toBe('https://kb.example.com');
    expect(ConfigSchema.safeParse({ server: { publicUrl: 'not a url' } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ server: { publicUrl: 'ftp://kb.example.com' } }).success).toBe(
      false,
    );
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

  test('remote.port no longer bakes a schema default (alias-read needs absence to be detectable)', () => {
    expect(ConfigSchema.parse({}).remote.port).toBeUndefined();
    expect(ConfigSchema.parse({ remote: { port: 24550 } }).remote.port).toBe(24550);
  });
});

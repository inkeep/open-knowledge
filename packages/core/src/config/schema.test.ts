import { describe, expect, test } from 'bun:test';
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

describe('linkPreviews.enabled (external link-hover preview egress opt-in)', () => {
  test('defaults to disabled when the block is absent', () => {
    expect(ConfigSchema.parse({}).linkPreviews).toEqual({ enabled: false });
  });

  test('defaults enabled to false when linkPreviews is present but enabled is absent', () => {
    expect(ConfigSchema.parse({ linkPreviews: {} }).linkPreviews.enabled).toBe(false);
  });

  test('accepts an explicit opt-in', () => {
    expect(ConfigSchema.parse({ linkPreviews: { enabled: true } }).linkPreviews.enabled).toBe(true);
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

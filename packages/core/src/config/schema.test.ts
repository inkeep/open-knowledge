import { describe, expect, test } from 'bun:test';
import {
  ConfigSchema,
  isValidAttachmentFolderPath,
  normalizeAttachmentFolderPath,
} from './schema.ts';

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

describe('legacy upload.* keys remain non-authoritative', () => {
  test('upload.* keys pass through looseObject without schema error', () => {
    const result = ConfigSchema.safeParse({
      upload: { attachmentFolder: 'attachments', maxSize: 10485760 },
    });
    expect(result.success).toBe(true);
  });
});

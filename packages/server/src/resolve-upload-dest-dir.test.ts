/**
 * Per-branch unit coverage for `resolveUploadDestDir` — the exported
 * 4-branch dispatch that honors the documented `content.attachmentFolderPath`
 * matrix (docs/content/guides/assets-and-embeds.mdx §"Where files land on
 * disk"). The upload handler's HTTP-integration tests exercise the `'./'`
 * default incidentally; this file covers the three branches not reached
 * by the happy path so a future refactor that flips the `'/'`-vs-`'./'`
 * semantics OR breaks bare-name resolution fails at PR time instead of
 * surfacing as a storage-location regression on an Obsidian-refugee
 * vault open (the acceptance scenario that depends on the
 * bare-name branch specifically).
 */
import { describe, expect, test } from 'bun:test';
import { resolveUploadDestDir } from './api-extension.ts';

describe('resolveUploadDestDir (SPEC §6 FR-5 + docs matrix)', () => {
  const root = '/vault';

  test('"./" → co-located with doc (default)', () => {
    expect(resolveUploadDestDir('docs/meeting.md', './', root)).toBe('/vault/docs');
  });

  test('"" (empty) → co-located with doc (fallback)', () => {
    expect(resolveUploadDestDir('docs/meeting.md', '', root)).toBe('/vault/docs');
  });

  test('whitespace-only → co-located with doc (fallback)', () => {
    expect(resolveUploadDestDir('docs/meeting.md', '  ', root)).toBe('/vault/docs');
  });

  test('"/" → content-directory root', () => {
    expect(resolveUploadDestDir('docs/meeting.md', '/', root)).toBe('/vault');
  });

  test('"./<sub>" → subdirectory beside the doc', () => {
    expect(resolveUploadDestDir('docs/meeting.md', './attachments', root)).toBe(
      '/vault/docs/attachments',
    );
  });

  test('"./<nested>" → nested subdirectory beside the doc', () => {
    expect(resolveUploadDestDir('docs/meeting.md', './assets/images', root)).toBe(
      '/vault/docs/assets/images',
    );
  });

  test('bare name → fixed content-relative location (P2 Obsidian-refugee case)', () => {
    expect(resolveUploadDestDir('docs/meeting.md', 'attachments', root)).toBe('/vault/attachments');
  });

  test('nested bare path → fixed content-relative location', () => {
    expect(resolveUploadDestDir('docs/meeting.md', 'assets/uploads', root)).toBe(
      '/vault/assets/uploads',
    );
  });

  test('doc in nested directory + "./" still resolves relative to its own dirname', () => {
    expect(resolveUploadDestDir('archive/2026/note.md', './', root)).toBe('/vault/archive/2026');
  });

  test('doc in nested directory + "./sub" layers under the docs dirname', () => {
    expect(resolveUploadDestDir('archive/2026/note.md', './sub', root)).toBe(
      '/vault/archive/2026/sub',
    );
  });

  test('doc in nested directory + bare name ignores the doc dir entirely', () => {
    expect(resolveUploadDestDir('archive/2026/note.md', 'attachments', root)).toBe(
      '/vault/attachments',
    );
  });
});

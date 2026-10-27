import { describe, expect, test } from 'vitest';
import { resolveUploadDestDir } from './api-extension.ts';

describe('resolveUploadDestDir (SPEC §6 FR-5 + docs matrix)', () => {
  const root = '/vault';

  test('"./" → co-located with doc', () => {
    expect(resolveUploadDestDir('docs/meeting.md', './', root)).toBe('/vault/docs');
  });

  test('"" (empty) → the default folder named after the doc', () => {
    expect(resolveUploadDestDir('docs/meeting.md', '', root)).toBe('/vault/docs/meeting.assets');
  });

  test('whitespace-only → the default folder named after the doc', () => {
    expect(resolveUploadDestDir('docs/meeting.md', '  ', root)).toBe('/vault/docs/meeting.assets');
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

  test.each([
    ['./{{filename}}.assets', 'docs/meeting.mdx', '/vault/docs/meeting.assets'],
    ['./{{filename}}.assets', 'docs/Meeting.MD', '/vault/docs/Meeting.assets'],
    ['./{{filename}}.assets', 'docs/v1.2.md', '/vault/docs/v1.2.assets'],
    ['./{{filename}}.assets', 'docs/meeting', '/vault/docs'],
    ['./{{filename}}.assets', 'model.stl', '/vault'],
    ['./{{filename}}.assets', 'LICENSE', '/vault'],
    ['/uploads/{{filename}}', 'docs/meeting.md', '/vault/uploads/meeting'],
    ['/attachments', 'docs/meeting.md', '/vault/attachments'],
    ['./{{filename}}.assets', 'diagram.png', '/vault'],
    ['/uploads/{{filename}}', 'diagram.png', '/vault'],
    ['/uploads/{{filename}}', 'docs/diagram.png', '/vault/docs'],
  ])('%s for %s resolves to %s', (attachmentFolderPath, parentDocName, expected) => {
    expect(resolveUploadDestDir(parentDocName, attachmentFolderPath, root)).toBe(expected);
  });

  test('doc in nested directory + bare name ignores the doc dir entirely', () => {
    expect(resolveUploadDestDir('archive/2026/note.md', 'attachments', root)).toBe(
      '/vault/attachments',
    );
  });
});

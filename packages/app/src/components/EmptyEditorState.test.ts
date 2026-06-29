import { describe, expect, test } from 'bun:test';
import { countEntries } from './EmptyEditorState';

describe('countEntries() — onboarding gate', () => {
  test('counts top-level documents and folders', () => {
    expect(
      countEntries([
        { kind: 'document', docName: 'INDEX' },
        { kind: 'folder', path: 'brain' },
      ]),
    ).toBe(2);
  });

  test('skips asset entries (only document + folder count)', () => {
    expect(
      countEntries([
        { kind: 'document', docName: 'INDEX' },
        { kind: 'asset', path: 'images/logo.png' },
      ]),
    ).toBe(1);
  });

  test('skips dotfile-prefixed top-level entries', () => {
    expect(
      countEntries([
        { kind: 'folder', path: '.private' },
        { kind: 'document', docName: '.config' },
      ]),
    ).toBe(0);
  });

  test('skips entries with a hidden segment at any depth', () => {
    expect(
      countEntries([
        { kind: 'document', docName: 'brain/.archived/note' },
        { kind: 'folder', path: 'brain/.archived' },
      ]),
    ).toBe(0);
  });

  test('keeps non-hidden entries when hidden entries are mixed in', () => {
    expect(
      countEntries([
        { kind: 'document', docName: 'brain/index' },
        { kind: 'folder', path: '.private' },
        { kind: 'document', docName: '.config' },
        { kind: 'folder', path: 'brain' },
      ]),
    ).toBe(2);
  });

  test('returns 0 when every entry is hidden — gates onboarding view', () => {
    expect(
      countEntries([
        { kind: 'folder', path: '.private' },
        { kind: 'document', docName: '.private/notes' },
      ]),
    ).toBe(0);
  });
});

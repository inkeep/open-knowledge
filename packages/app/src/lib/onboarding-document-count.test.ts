import { describe, expect, test } from 'bun:test';
import type { DocumentListSuccess } from '@inkeep/open-knowledge-core';
import { countVisibleEntries } from './onboarding-document-count';

type Entry = DocumentListSuccess['documents'][number];

// The wire entry carries several always-present fields; the counting rule only
// reads `kind` / `docName` / `path`, so the rest are inert defaults.
const base = {
  docExt: '.md',
  size: 0,
  modified: '2026-06-30',
  isSymlink: false,
  canonicalDocName: null,
  targetPath: null,
} as const;

const doc = (docName: string): Entry => ({ ...base, kind: 'document', docName }) as Entry;
const folder = (path: string): Entry => ({ ...base, kind: 'folder', path }) as Entry;
const asset = (path: string): Entry =>
  ({ ...base, kind: 'asset', path, assetExt: '.png', referencedBy: [] }) as Entry;
const file = (path: string): Entry => ({ ...base, kind: 'file', path }) as Entry;

describe('countVisibleEntries', () => {
  test('an empty project counts zero', () => {
    expect(countVisibleEntries([])).toBe(0);
  });

  test('counts documents', () => {
    expect(countVisibleEntries([doc('welcome'), doc('notes')])).toBe(2);
  });

  test('counts folders — starter packs often scaffold only folders', () => {
    expect(countVisibleEntries([folder('guides'), folder('references')])).toBe(2);
  });

  test('counts documents and folders together', () => {
    expect(countVisibleEntries([doc('welcome'), folder('guides'), doc('notes')])).toBe(3);
  });

  test('excludes assets and bare non-markdown files', () => {
    expect(countVisibleEntries([doc('welcome'), asset('logo.png'), file('data.csv')])).toBe(1);
  });

  test('excludes hidden entries (dotfiles, .ok config, .git)', () => {
    expect(countVisibleEntries([doc('welcome'), doc('.ok/config'), folder('.git')])).toBe(1);
  });

  test('excludes entries that ship without a docName or path', () => {
    expect(countVisibleEntries([doc(''), folder('')])).toBe(0);
  });

  test('sidebar view toggles cannot alter the count — the counter has no axis input', () => {
    // Entries a view toggle could reveal (dot-path via show-hidden, .ok via
    // show-ok) or drop (non-markdown via only-markdown) must not move the
    // onboarding gate: the count always uses default visibility.
    expect(
      countVisibleEntries([
        doc('welcome'),
        folder('guides'),
        doc('.scratch/wip'),
        doc('.ok/skills/research/SKILL'),
        asset('logo.png'),
        file('data.csv'),
      ]),
    ).toBe(2);
  });
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE16_SLOTS } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  SAVED_THEME_FILE_BYTE_LIMIT,
  SAVED_THEME_SCAN_CAP,
  type SavedThemeEntry,
  savedThemesDir,
  scanSavedThemes,
} from './saved-themes-store.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ok-saved-themes-home-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A valid nested Tinted Theming scheme: all sixteen slots, distinct hex per slot. */
function validSchemeYaml(name: string): string {
  const palette = BASE16_SLOTS.map((slot, i) => {
    const byte = (i * 16).toString(16).padStart(2, '0');
    return `  ${slot}: "#${byte}${byte}${byte}"`;
  }).join('\n');
  return `name: "${name}"\nvariant: "dark"\npalette:\n${palette}\n`;
}

/** Create `<home>/.ok/themes` and write one file into it, returning the store dir. */
function seedStore(files: Record<string, string>): string {
  const dir = savedThemesDir(home);
  mkdirSync(dir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(dir, filename), content);
  }
  return dir;
}

function byId(entries: SavedThemeEntry[]): Map<string | undefined, SavedThemeEntry> {
  return new Map(entries.map((e) => [e.ok ? e.id : e.filename, e]));
}

describe('savedThemesDir', () => {
  test('resolves the store under <home>/.ok/themes', () => {
    expect(savedThemesDir(home)).toBe(join(home, '.ok', 'themes'));
  });
});

describe('scanSavedThemes', () => {
  test('lists one entry per scheme file, id = prefix + filename stem', () => {
    seedStore({ 'midnight.yaml': validSchemeYaml('Midnight') });

    const result = scanSavedThemes({ homedirOverride: home });

    expect(result.truncated).toBe(false);
    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry).toMatchObject({
      ok: true,
      id: 'saved-midnight',
      filename: 'midnight.yaml',
    });
    if (entry?.ok) {
      expect(entry.scheme.name).toBe('Midnight');
      expect(entry.scheme.variant).toBe('dark');
      expect(Object.keys(entry.scheme.palette)).toHaveLength(16);
    }
  });

  test('a missing store folder reads as empty and is never created', () => {
    const result = scanSavedThemes({ homedirOverride: home });

    expect(result).toEqual({ entries: [], truncated: false });
    // No lazy write: reading an absent store must not materialize it.
    expect(existsSync(savedThemesDir(home))).toBe(false);
  });

  test('an existing but empty store reads as empty', () => {
    seedStore({});
    expect(scanSavedThemes({ homedirOverride: home })).toEqual({ entries: [], truncated: false });
  });

  test('one malformed file never fails enumeration; it is listed with a code', () => {
    seedStore({
      'good.yaml': validSchemeYaml('Good'),
      'broken.yaml': 'name: "Broken"\npalette:\n  base00: "#000000"\n', // missing 15 slots
    });

    const entries = byId(scanSavedThemes({ homedirOverride: home }).entries);

    expect(entries.get('saved-good')).toMatchObject({ ok: true });
    // The bad file is present, not hidden, and carries the machine-readable reason.
    expect(entries.get('broken.yaml')).toEqual({
      ok: false,
      filename: 'broken.yaml',
      id: 'saved-broken',
      code: 'missing-slots',
    });
  });

  test('lists a U+0085-only name as a not-a-scheme warning', () => {
    seedStore({ 'blank-name.yaml': validSchemeYaml('\\u0085') });

    expect(scanSavedThemes({ homedirOverride: home }).entries).toEqual([
      {
        ok: false,
        filename: 'blank-name.yaml',
        id: 'saved-blank-name',
        code: 'not-a-scheme',
      },
    ]);
  });

  test('a non-hex value is reported per-entry rather than dropped', () => {
    const badHex = validSchemeYaml('BadHex').replace('#000000', '#zzzzzz');
    seedStore({ 'badhex.yaml': badHex });

    expect(scanSavedThemes({ homedirOverride: home }).entries).toEqual([
      { ok: false, filename: 'badhex.yaml', id: 'saved-badhex', code: 'bad-hex' },
    ]);
  });

  test('a name that overflows the id budget is listed, not truncated', () => {
    // 27-char stem → saved-<27> = 33 chars, past the 32-char id grammar.
    const filename = `${'a'.repeat(27)}.yaml`;
    seedStore({ [filename]: validSchemeYaml('TooLong') });

    expect(scanSavedThemes({ homedirOverride: home }).entries).toEqual([
      { ok: false, filename, code: 'too-long' },
    ]);
  });

  test('a name outside the grammar is listed with invalid-chars', () => {
    seedStore({ 'My Theme.yaml': validSchemeYaml('My Theme') });

    expect(scanSavedThemes({ homedirOverride: home }).entries).toEqual([
      { ok: false, filename: 'My Theme.yaml', code: 'invalid-chars' },
    ]);
  });

  test('keeps an uppercase stem invalid and distinct from its lowercase identity', () => {
    const dir = seedStore({ 'Ocean.yaml': validSchemeYaml('Uppercase stem') });

    expect(scanSavedThemes({ homedirOverride: home }).entries).toEqual([
      { ok: false, filename: 'Ocean.yaml', code: 'invalid-chars' },
    ]);

    // Case-insensitive filesystems cannot hold the mixed-case pair. The
    // uppercase-only assertion above still verifies their scanner behavior.
    if (existsSync(join(dir, 'ocean.yaml'))) return;

    writeFileSync(join(dir, 'ocean.yaml'), validSchemeYaml('Lowercase stem'));
    const entries = scanSavedThemes({ homedirOverride: home }).entries;
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({
      ok: false,
      filename: 'Ocean.yaml',
      code: 'invalid-chars',
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        ok: true,
        id: 'saved-ocean',
        filename: 'ocean.yaml',
        scheme: expect.objectContaining({ name: 'Lowercase stem' }),
      }),
    );
  });

  test('non-scheme files and hidden files are skipped, not listed as errors', () => {
    seedStore({
      'real.yaml': validSchemeYaml('Real'),
      'notes.txt': 'not a theme',
      '.DS_Store': '\0\0',
      '.hidden.yaml': validSchemeYaml('Hidden'),
    });

    const result = scanSavedThemes({ homedirOverride: home });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ ok: true, id: 'saved-real' });
  });

  test('lists a symlinked scheme as unsafe without reading its target', () => {
    const dir = seedStore({ target: validSchemeYaml('Target') });
    symlinkSync(join(dir, 'target'), join(dir, 'linked.yaml'));

    expect(scanSavedThemes({ homedirOverride: home }).entries).toEqual([
      { ok: false, filename: 'linked.yaml', id: 'saved-linked', code: 'symlink' },
    ]);
  });

  test('lists a non-regular scheme path as an unsupported file type', () => {
    const dir = seedStore({});
    mkdirSync(join(dir, 'folder.yaml'));

    expect(scanSavedThemes({ homedirOverride: home }).entries).toEqual([
      {
        ok: false,
        filename: 'folder.yaml',
        id: 'saved-folder',
        code: 'not-regular-file',
      },
    ]);
  });

  test('lists an oversized scheme without reading or parsing it', () => {
    seedStore({ 'huge.yaml': 'x'.repeat(SAVED_THEME_FILE_BYTE_LIMIT + 1) });

    expect(scanSavedThemes({ homedirOverride: home }).entries).toEqual([
      { ok: false, filename: 'huge.yaml', id: 'saved-huge', code: 'file-too-large' },
    ]);
  });

  test('accepts the .yml extension as well as .yaml', () => {
    seedStore({ 'terse.yml': validSchemeYaml('Terse') });
    expect(scanSavedThemes({ homedirOverride: home }).entries).toMatchObject([
      { ok: true, id: 'saved-terse' },
    ]);
  });

  test('lists a case-variant YAML extension as an unsupported warning', () => {
    seedStore({ 'upper.YAML': validSchemeYaml('Upper') });

    expect(scanSavedThemes({ homedirOverride: home }).entries).toEqual([
      {
        ok: false,
        filename: 'upper.YAML',
        id: 'saved-upper',
        code: 'unsupported-extension-case',
      },
    ]);
  });

  test('lists duplicate filename stems as one conflict warning', () => {
    seedStore({
      'conflict.yaml': validSchemeYaml('YAML'),
      'conflict.yml': validSchemeYaml('YML'),
    });

    expect(scanSavedThemes({ homedirOverride: home }).entries).toEqual([
      {
        ok: false,
        filename: 'conflict.yaml',
        id: 'saved-conflict',
        code: 'duplicate-identity',
        conflictingFilenames: ['conflict.yaml', 'conflict.yml'],
      },
    ]);
  });

  test('reports truncation instead of silently cutting the list', () => {
    const dir = seedStore({
      'a.yaml': validSchemeYaml('A'),
      'b.yaml': validSchemeYaml('B'),
      'c.yaml': validSchemeYaml('C'),
    });

    const result = scanSavedThemes({ root: dir, cap: 2 });
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(2);
    // Sorted, so truncation drops the tail deterministically.
    expect(result.entries.map((e) => e.filename)).toEqual(['a.yaml', 'b.yaml']);
  });

  test('bounds directory observation and reports that the result is truncated', () => {
    const dir = seedStore({
      'a.yaml': validSchemeYaml('A'),
      'b.yaml': validSchemeYaml('B'),
      'c.yaml': validSchemeYaml('C'),
    });

    const result = scanSavedThemes({ root: dir, observationCap: 2 });

    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(2);
  });

  test('exactly cap files is not truncated', () => {
    const dir = seedStore({ 'a.yaml': validSchemeYaml('A'), 'b.yaml': validSchemeYaml('B') });
    expect(scanSavedThemes({ root: dir, cap: 2 }).truncated).toBe(false);
  });

  test('the default cap is a bounded positive number', () => {
    expect(SAVED_THEME_SCAN_CAP).toBeGreaterThan(0);
  });

  test('scanning writes nothing back to the store', () => {
    const dir = seedStore({ 'only.yaml': validSchemeYaml('Only') });
    scanSavedThemes({ homedirOverride: home });
    // The reader persists no provenance file, index, or lockfile alongside themes.
    expect(readdirSync(dir).sort()).toEqual(['only.yaml']);
  });
});

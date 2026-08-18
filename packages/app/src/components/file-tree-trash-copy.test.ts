/**
 * Verbatim-copy tests for the VSCode-parity Trash confirm modal. Every
 * single-target / multi-target permutation is pinned at the string level so a
 * future refactor that "improves" the phrasing cannot silently drift away
 * from VSCode parity.
 *
 * The copy is Lingui-wrapped, and the app's vitest config aliases the macros
 * to an English-passthrough shim — so these assertions pin the `en` source
 * text, which is exactly what VSCode parity is a claim about.
 *
 * VSCode source: `microsoft/vscode/blob/main/src/vs/workbench/contrib/files/browser/fileActions.ts`
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { FileTreeTarget } from '@/components/file-tree-operations';
import {
  buildTrashConfirmCopyElectron,
  selectTrashConfirmCopy,
  trashDetailMacos,
  trashDetailWindows,
  trashTargetDisplayName,
} from '@/components/file-tree-trash-copy';

function file(name: string, docExt = '.md'): FileTreeTarget {
  return { kind: 'file', path: name, name, docExt };
}

function folder(name: string): FileTreeTarget {
  return { kind: 'folder', path: name, name };
}

function asset(path: string): FileTreeTarget {
  return { kind: 'asset', path, name: path.split('/').pop() ?? path };
}

describe('file-tree-trash-copy — buildTrashConfirmCopyElectron VSCode-verbatim copy (FR8)', () => {
  test('single file → \'Are you sure you want to delete "<name>"?\'', () => {
    const copy = buildTrashConfirmCopyElectron([file('notes')]);
    expect(copy.title).toBe('Are you sure you want to delete "notes"?');
    expect(copy.listedTargets).toBeNull();
  });

  test('single folder → \'Are you sure you want to delete "<name>" and its contents?\'', () => {
    const copy = buildTrashConfirmCopyElectron([folder('drafts')]);
    expect(copy.title).toBe('Are you sure you want to delete "drafts" and its contents?');
    expect(copy.listedTargets).toBeNull();
  });

  test('multi files → "Are you sure you want to delete the following N files?"', () => {
    const copy = buildTrashConfirmCopyElectron([file('a'), file('b'), file('c')]);
    expect(copy.title).toBe('Are you sure you want to delete the following 3 files?');
    expect(copy.listedTargets).toHaveLength(3);
  });

  test('multi folders → "the following N directories and their contents"', () => {
    const copy = buildTrashConfirmCopyElectron([folder('a'), folder('b')]);
    expect(copy.title).toBe(
      'Are you sure you want to delete the following 2 directories and their contents?',
    );
    expect(copy.listedTargets).toHaveLength(2);
  });

  test('multi mixed (files + folders) → "the following N files/directories and their contents"', () => {
    const copy = buildTrashConfirmCopyElectron([file('a'), folder('b'), file('c')]);
    expect(copy.title).toBe(
      'Are you sure you want to delete the following 3 files/directories and their contents?',
    );
    expect(copy.listedTargets).toHaveLength(3);
  });

  test('asset targets use file copy', () => {
    expect(buildTrashConfirmCopyElectron([asset('photo.png')]).title).toBe(
      'Are you sure you want to delete "photo.png"?',
    );
    const copy = buildTrashConfirmCopyElectron([asset('images/logo.png'), folder('images')]);
    expect(copy.title).toBe(
      'Are you sure you want to delete the following 2 files/directories and their contents?',
    );
    expect(copy.listedTargets).toHaveLength(2);
  });

  test('detail line is macOS-verbatim (single + multi)', () => {
    expect(trashDetailMacos()).toBe('You can restore this file from the Trash.');
    expect(buildTrashConfirmCopyElectron([file('a')]).detail).toBe(trashDetailMacos());
    expect(buildTrashConfirmCopyElectron([file('a'), folder('b')]).detail).toBe(trashDetailMacos());
  });

  test('confirm button label is "Move to Trash" with "Moving" while in-flight', () => {
    const copy = buildTrashConfirmCopyElectron([file('a')]);
    expect(copy.confirmLabel).toBe('Move to Trash');
    expect(copy.confirmLabelBusy).toBe('Moving');
  });

  test('empty targets gives a defensive shape — never throws', () => {
    const copy = buildTrashConfirmCopyElectron([]);
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.confirmLabel).toBe('Move to Trash');
  });

  test('multi-target list is preserved in order', () => {
    const copy = buildTrashConfirmCopyElectron([file('a'), folder('b'), file('c')]);
    expect(copy.listedTargets?.map((t) => t.path)).toEqual(['a', 'b', 'c']);
  });
});

describe('file-tree-trash-copy — Windows destination noun (Recycle Bin)', () => {
  test('win32 swaps the detail and confirm label; title is unchanged', () => {
    const copy = buildTrashConfirmCopyElectron([file('notes')], 'win32');
    expect(copy.title).toBe('Are you sure you want to delete "notes"?');
    expect(copy.detail).toBe(trashDetailWindows());
    expect(copy.detail).toBe('You can restore this file from the Recycle Bin.');
    expect(copy.confirmLabel).toBe('Move to Recycle Bin');
  });

  test('darwin and linux keep the Trash strings', () => {
    for (const platform of ['darwin', 'linux', undefined]) {
      const copy = buildTrashConfirmCopyElectron([file('notes')], platform);
      expect(copy.detail).toBe(trashDetailMacos());
      expect(copy.confirmLabel).toBe('Move to Trash');
    }
  });

  test('selectTrashConfirmCopy threads the platform through', () => {
    const copy = selectTrashConfirmCopy('electron', [file('a')], 'win32');
    expect(copy?.confirmLabel).toBe('Move to Recycle Bin');
  });
});

describe('file-tree-trash-copy — selectTrashConfirmCopy variant gating (D34)', () => {
  test("web variant returns null — preserves today's hard-delete copy", () => {
    expect(selectTrashConfirmCopy('web', [file('a')])).toBeNull();
    expect(selectTrashConfirmCopy('web', [folder('a'), file('b')])).toBeNull();
  });

  test('electron variant returns the buildTrashConfirmCopyElectron output', () => {
    const copy = selectTrashConfirmCopy('electron', [file('a')]);
    expect(copy).not.toBeNull();
    expect(copy?.title).toBe('Are you sure you want to delete "a"?');
  });
});

describe('file-tree-trash-copy — trashTargetDisplayName', () => {
  test('folder gets trailing slash', () => {
    expect(trashTargetDisplayName(folder('drafts'))).toBe('drafts/');
  });

  test('file shows docExt when present', () => {
    expect(trashTargetDisplayName(file('notes', '.md'))).toBe('notes.md');
    expect(trashTargetDisplayName(file('notes', '.mdx'))).toBe('notes.mdx');
  });

  test('file without docExt shows bare name', () => {
    expect(trashTargetDisplayName({ kind: 'file', path: 'x', name: 'x' })).toBe('x');
  });

  test('asset shows its filename without markdown extension synthesis', () => {
    expect(trashTargetDisplayName(asset('images/logo.png'))).toBe('logo.png');
  });
});

describe('file-tree-trash-copy — ICU escape regression guard', () => {
  // Lingui compiles catalogs as ICU MessageFormat. Wrapping an interpolation
  // in `'…'` (single quotes) in the source template — e.g.
  // `` t`delete '${name}'` `` — extracts the msgid `"delete '{name}'"`, which
  // ICU treats as an ESCAPED literal: the compiled catalog collapses the whole
  // thing to `"delete {name}"` with no interpolation slot and the runtime
  // renders `{name}` verbatim to the user. `"…"` (double quotes) have no ICU
  // escape meaning and interpolate correctly.
  //
  // The test-harness Lingui macro shim (`tests/lingui-macro-shim.tsx`) is a
  // plain template-literal reduce with no ICU parsing, so a `t\`… '${x}' …\``
  // call resolves through it correctly even when the shipped catalog would
  // not. Any assertion made against `buildTrashConfirmCopyElectron(...).title`
  // therefore passes with the bug present — the guard has to run at the
  // artifact layer, not the source layer. Read the compiled JSON catalog and
  // check the message shape: a valid interpolating message compiles to an
  // array containing at least one `["name"]` slot; the buggy form compiles
  // to a single flat string with `{name}` living inside literal text. Same
  // check runs across every shipped locale so a translator can't reintroduce
  // the escape by wrapping the placeholder in single quotes.
  // Locale sweep — walk `src/locales/*/messages.json` from disk so a new
  // locale gets covered automatically the moment it lands. `pseudo` is
  // structurally identical to `en` (it just character-substitutes the source
  // string) and skipping it keeps the assertion focused on the shipped set.
  const localeDir = fileURLToPath(new URL('../locales/', import.meta.url));
  const shippedLocales = readdirSync(localeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'pseudo')
    .map((entry) => entry.name);

  function loadCatalog(locale: string): { messages: Record<string, unknown> } {
    return JSON.parse(
      readFileSync(new URL(`../locales/${locale}/messages.json`, import.meta.url), 'utf8'),
    ) as { messages: Record<string, unknown> };
  }

  function joinFlat(entry: unknown): string {
    if (Array.isArray(entry)) {
      return entry.filter((part): part is string => typeof part === 'string').join('');
    }
    return typeof entry === 'string' ? entry : '';
  }

  /** Re-render a compiled entry back to source shape (with placeholders
   *  written as `{name}`), so an exact-string anchor can match a compiled
   *  entry against its known-good English source string. */
  function joinWithSlots(entry: unknown): string {
    if (Array.isArray(entry)) {
      return entry
        .map((part) => {
          if (typeof part === 'string') return part;
          if (Array.isArray(part) && typeof part[0] === 'string') return `{${part[0]}}`;
          return '';
        })
        .join('');
    }
    return typeof entry === 'string' ? entry : '';
  }

  // Derive the two guarded msgIds by matching against the English source
  // strings in the en catalog. Lingui hashes the English source into a stable
  // id; when the source is edited, the hash regenerates — so anchoring by id
  // directly rots on any legitimate copy tweak. Anchoring by an English
  // substring in the en catalog and then reusing the id across every locale
  // sidesteps both problems: id stays live under source edits, and the
  // localized catalogs (whose flat text is in the target language, not
  // English) can still be walked by id.
  const enCatalog = loadCatalog('en');
  const trashFileEntry = Object.entries(enCatalog.messages).find(
    ([, entry]) => joinWithSlots(entry) === 'Are you sure you want to delete "{name}"?',
  );
  const trashFolderEntry = Object.entries(enCatalog.messages).find(
    ([, entry]) =>
      joinWithSlots(entry) === 'Are you sure you want to delete "{name}" and its contents?',
  );

  test('anchor lookup finds both trash-copy entries in the en catalog', () => {
    // Guardrail so the sweep below isn't silently vacuous — if either lookup
    // fails, every downstream test-each also fails but with a less-clear
    // error, so surface the root cause up front.
    expect(trashFileEntry, 'single-file trash-copy entry not found in en catalog').toBeDefined();
    expect(
      trashFolderEntry,
      'single-folder trash-copy entry not found in en catalog',
    ).toBeDefined();
  });

  const fileId = trashFileEntry?.[0];
  const folderId = trashFolderEntry?.[0];

  // Structural guard: the two entries, in every locale, must be an array
  // that contains a `["name"]` interpolation slot AND has no literal
  // `{name}` substring anywhere in its flat text portions. The buggy shape
  // is a single flat string with `{name}` embedded (no slot). This shape
  // check catches the ICU escape hazard for the exact entries the bug hit.
  function assertInterpolatingSlot(entry: unknown, msgLocation: string): void {
    expect(Array.isArray(entry), `${msgLocation}: entry is not an array`).toBe(true);
    if (!Array.isArray(entry)) return;
    const hasSlot = entry.some((part) => Array.isArray(part) && part[0] === 'name');
    const flat = joinFlat(entry);
    const hasLiteralPlaceholder = /\{[a-zA-Z_][a-zA-Z0-9_]*\}/.test(flat);
    expect(hasSlot, `${msgLocation}: no ["name"] interpolation slot`).toBe(true);
    expect(
      hasLiteralPlaceholder,
      `${msgLocation}: has literal {…} in flat text — ICU escape hazard`,
    ).toBe(false);
  }

  test.each(
    shippedLocales,
  )('compiled `%s` catalog: single-file trash-copy entry has an interpolation slot', (locale) => {
    if (fileId === undefined)
      throw new Error('anchor missing — earlier test surfaces the root cause');
    const entry = loadCatalog(locale).messages[fileId];
    assertInterpolatingSlot(entry, `${locale}/${fileId}`);
  });

  test.each(
    shippedLocales,
  )('compiled `%s` catalog: single-folder trash-copy entry has an interpolation slot', (locale) => {
    if (folderId === undefined)
      throw new Error('anchor missing — earlier test surfaces the root cause');
    const entry = loadCatalog(locale).messages[folderId];
    assertInterpolatingSlot(entry, `${locale}/${folderId}`);
  });
});

describe('file-tree-trash-copy — source-layer smoke tests', () => {
  // Not the primary regression guard — the compiled-catalog tests above catch
  // the ICU escape bug. These pin the shape of the source function's return
  // value so a refactor that drops `${name}` interpolation entirely doesn't
  // slip through undetected.
  test('single-file title contains the file name (source-layer sanity)', () => {
    const copy = buildTrashConfirmCopyElectron([file('foo.md')]);
    expect(copy.title).toContain('foo.md');
  });

  test('single-folder title contains the folder name (source-layer sanity)', () => {
    const copy = buildTrashConfirmCopyElectron([folder('drafts')]);
    expect(copy.title).toContain('drafts');
  });
});

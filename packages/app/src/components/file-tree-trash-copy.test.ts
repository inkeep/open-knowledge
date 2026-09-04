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

  const enCatalog = loadCatalog('en');
  const trashFileEntry = Object.entries(enCatalog.messages).find(
    ([, entry]) => joinWithSlots(entry) === 'Are you sure you want to delete "{name}"?',
  );
  const trashFolderEntry = Object.entries(enCatalog.messages).find(
    ([, entry]) =>
      joinWithSlots(entry) === 'Are you sure you want to delete "{name}" and its contents?',
  );

  test('anchor lookup finds both trash-copy entries in the en catalog', () => {
    expect(trashFileEntry, 'single-file trash-copy entry not found in en catalog').toBeDefined();
    expect(
      trashFolderEntry,
      'single-folder trash-copy entry not found in en catalog',
    ).toBeDefined();
  });

  const fileId = trashFileEntry?.[0];
  const folderId = trashFolderEntry?.[0];

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
  test('single-file title contains the file name (source-layer sanity)', () => {
    const copy = buildTrashConfirmCopyElectron([file('foo.md')]);
    expect(copy.title).toContain('foo.md');
  });

  test('single-folder title contains the folder name (source-layer sanity)', () => {
    const copy = buildTrashConfirmCopyElectron([folder('drafts')]);
    expect(copy.title).toContain('drafts');
  });
});

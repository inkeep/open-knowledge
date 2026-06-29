import { describe, expect, test } from 'bun:test';
import type { FileTreeTarget } from '@/components/file-tree-operations';
import {
  buildTrashConfirmCopyElectron,
  selectTrashConfirmCopy,
  TRASH_DETAIL_MACOS,
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
  test('single file → "Are you sure you want to delete \'<name>\'?"', () => {
    const copy = buildTrashConfirmCopyElectron([file('notes')]);
    expect(copy.title).toBe("Are you sure you want to delete 'notes'?");
    expect(copy.listedTargets).toBeNull();
  });

  test('single folder → "Are you sure you want to delete \'<name>\' and its contents?"', () => {
    const copy = buildTrashConfirmCopyElectron([folder('drafts')]);
    expect(copy.title).toBe("Are you sure you want to delete 'drafts' and its contents?");
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
      "Are you sure you want to delete 'photo.png'?",
    );
    const copy = buildTrashConfirmCopyElectron([asset('images/logo.png'), folder('images')]);
    expect(copy.title).toBe(
      'Are you sure you want to delete the following 2 files/directories and their contents?',
    );
    expect(copy.listedTargets).toHaveLength(2);
  });

  test('detail line is macOS-verbatim (single + multi)', () => {
    expect(TRASH_DETAIL_MACOS).toBe('You can restore this file from the Trash.');
    expect(buildTrashConfirmCopyElectron([file('a')]).detail).toBe(TRASH_DETAIL_MACOS);
    expect(buildTrashConfirmCopyElectron([file('a'), folder('b')]).detail).toBe(TRASH_DETAIL_MACOS);
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

describe('file-tree-trash-copy — selectTrashConfirmCopy variant gating (D34)', () => {
  test("web variant returns null — preserves today's hard-delete copy", () => {
    expect(selectTrashConfirmCopy('web', [file('a')])).toBeNull();
    expect(selectTrashConfirmCopy('web', [folder('a'), file('b')])).toBeNull();
  });

  test('electron variant returns the buildTrashConfirmCopyElectron output', () => {
    const copy = selectTrashConfirmCopy('electron', [file('a')]);
    expect(copy).not.toBeNull();
    expect(copy?.title).toBe("Are you sure you want to delete 'a'?");
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

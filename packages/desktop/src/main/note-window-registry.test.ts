import { afterEach, describe, expect, test } from 'vitest';
import {
  __resetNoteWindowRegistryForTests,
  findNoteWindowForDoc,
  getNoteWindowContext,
  listNoteWindows,
  listNoteWindowsForProject,
  registerNoteWindow,
  setNoteWindowDoc,
  touchNoteWindow,
  unregisterNoteWindow,
} from './note-window-registry.ts';

const PROJECT_A = '/Users/me/project-a';
const PROJECT_B = '/Users/me/project-b';

function ctx(projectRoot: string, currentDocName: string) {
  return {
    projectRoot,
    collabUrl: 'ws://localhost:5200/collab',
    apiOrigin: 'http://localhost:5200',
    currentDocName,
  };
}

afterEach(() => {
  __resetNoteWindowRegistryForTests();
});

describe('note-window registry', () => {
  test('round-trips a registered window context by windowId', () => {
    registerNoteWindow(1, ctx(PROJECT_A, 'notes/alpha'));
    expect(getNoteWindowContext(1)).toEqual(ctx(PROJECT_A, 'notes/alpha'));
  });

  test('returns undefined for an unregistered window', () => {
    expect(getNoteWindowContext(999)).toBeUndefined();
  });

  test('unregister removes the entry', () => {
    registerNoteWindow(1, ctx(PROJECT_A, 'notes/alpha'));
    unregisterNoteWindow(1);
    expect(getNoteWindowContext(1)).toBeUndefined();
  });
});

describe('note-window dedup identity', () => {
  test('finds the window showing a document in a project', () => {
    registerNoteWindow(1, ctx(PROJECT_A, 'notes/alpha'));
    expect(findNoteWindowForDoc(PROJECT_A, 'notes/alpha')).toBe(1);
  });

  test('does not match the same document name in a different project', () => {
    registerNoteWindow(1, ctx(PROJECT_A, 'notes/alpha'));
    expect(findNoteWindowForDoc(PROJECT_B, 'notes/alpha')).toBeUndefined();
  });

  test('does not match a different document in the same project', () => {
    registerNoteWindow(1, ctx(PROJECT_A, 'notes/alpha'));
    expect(findNoteWindowForDoc(PROJECT_A, 'notes/beta')).toBeUndefined();
  });

  test('identity follows in-place navigation rather than the birth document', () => {
    registerNoteWindow(1, ctx(PROJECT_A, 'notes/alpha'));
    expect(setNoteWindowDoc(1, 'notes/beta')).toBe(true);

    expect(findNoteWindowForDoc(PROJECT_A, 'notes/beta')).toBe(1);
    expect(findNoteWindowForDoc(PROJECT_A, 'notes/alpha')).toBeUndefined();
  });

  test('a navigation push for an unregistered window is ignored, not resurrected', () => {
    expect(setNoteWindowDoc(404, 'notes/ghost')).toBe(false);
    expect(getNoteWindowContext(404)).toBeUndefined();
  });

  test('two windows on one identity resolve most-recently-used', () => {
    registerNoteWindow(1, ctx(PROJECT_A, 'notes/alpha'));
    registerNoteWindow(2, ctx(PROJECT_A, 'notes/beta'));
    setNoteWindowDoc(2, 'notes/alpha');

    expect(findNoteWindowForDoc(PROJECT_A, 'notes/alpha')).toBe(2);

    touchNoteWindow(1);
    expect(findNoteWindowForDoc(PROJECT_A, 'notes/alpha')).toBe(1);
  });

  test('touching an unregistered window is a no-op', () => {
    registerNoteWindow(1, ctx(PROJECT_A, 'notes/alpha'));
    touchNoteWindow(404);
    expect(findNoteWindowForDoc(PROJECT_A, 'notes/alpha')).toBe(1);
  });
});

describe('note-window enumeration', () => {
  test('N windows coexist for one project and across projects', () => {
    registerNoteWindow(1, ctx(PROJECT_A, 'notes/alpha'));
    registerNoteWindow(2, ctx(PROJECT_A, 'notes/beta'));
    registerNoteWindow(3, ctx(PROJECT_B, 'notes/gamma'));

    expect(listNoteWindowsForProject(PROJECT_A)).toEqual([1, 2]);
    expect(listNoteWindowsForProject(PROJECT_B)).toEqual([3]);
    expect(listNoteWindows()).toHaveLength(3);
  });

  test('listNoteWindows carries each window current document for the restore snapshot', () => {
    registerNoteWindow(1, ctx(PROJECT_A, 'notes/alpha'));
    setNoteWindowDoc(1, 'notes/navigated-here');

    expect(listNoteWindows()).toEqual([
      { windowId: 1, context: ctx(PROJECT_A, 'notes/navigated-here') },
    ]);
  });

  test('a project with no note windows enumerates empty', () => {
    expect(listNoteWindowsForProject(PROJECT_A)).toEqual([]);
  });
});

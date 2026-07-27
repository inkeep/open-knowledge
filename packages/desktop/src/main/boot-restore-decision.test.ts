import { describe, expect, test } from 'vitest';
import { bootRestoreDecision, resolveRestoreActions } from './boot-restore-decision.ts';
import type { RestoredWindow } from './state-store.ts';

function existsIn(paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

const proj = (projectPath: string): RestoredWindow => ({ kind: 'project', projectPath });
const file = (filePath: string): RestoredWindow => ({ kind: 'file', filePath });

describe('bootRestoreDecision', () => {
  test('empty restore snapshot does not fall through to lastOpened', () => {
    const decision = bootRestoreDecision({
      pendingRestore: [],
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: existsIn(['/projects/last']),
      urlLaunch: false,
    });
    expect(decision).toEqual({ clearSnapshot: true, action: 'navigator' });
  });

  test('optionHeld with a non-empty snapshot consumes but suppresses restore', () => {
    const decision = bootRestoreDecision({
      pendingRestore: [proj('/projects/a'), proj('/projects/b')],
      lastOpenedProject: '/projects/last',
      optionHeld: true,
      pathExists: existsIn(['/projects/a', '/projects/b', '/projects/last']),
      urlLaunch: false,
    });
    expect(decision).toEqual({ clearSnapshot: true, action: 'navigator' });
  });

  test('non-empty snapshot with all paths existing restores in order', () => {
    const decision = bootRestoreDecision({
      pendingRestore: [proj('/projects/a'), proj('/projects/b'), proj('/projects/c')],
      lastOpenedProject: null,
      optionHeld: false,
      pathExists: existsIn(['/projects/a', '/projects/b', '/projects/c']),
      urlLaunch: false,
    });
    expect(decision).toEqual({
      clearSnapshot: true,
      action: 'restore',
      windows: [proj('/projects/a'), proj('/projects/b'), proj('/projects/c')],
    });
  });

  test('mixed project + loose-file snapshot restores both kinds in order', () => {
    const decision = bootRestoreDecision({
      pendingRestore: [proj('/projects/a'), file('/notes/todo.md'), proj('/projects/b')],
      lastOpenedProject: null,
      optionHeld: false,
      pathExists: existsIn(['/projects/a', '/notes/todo.md', '/projects/b']),
      urlLaunch: false,
    });
    expect(decision).toEqual({
      clearSnapshot: true,
      action: 'restore',
      windows: [proj('/projects/a'), file('/notes/todo.md'), proj('/projects/b')],
    });
  });

  test('missing targets are filtered by existence for BOTH kinds', () => {
    const decision = bootRestoreDecision({
      pendingRestore: [
        proj('/projects/a'),
        file('/notes/gone.md'),
        proj('/projects/gone'),
        file('/notes/keep.md'),
      ],
      lastOpenedProject: null,
      optionHeld: false,
      pathExists: existsIn(['/projects/a', '/notes/keep.md']),
      urlLaunch: false,
    });
    expect(decision).toEqual({
      clearSnapshot: true,
      action: 'restore',
      windows: [proj('/projects/a'), file('/notes/keep.md')],
    });
  });

  test('snapshot with all targets missing opens the navigator', () => {
    const decision = bootRestoreDecision({
      pendingRestore: [proj('/projects/gone1'), file('/notes/gone2.md')],
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: existsIn(['/projects/last']),
      urlLaunch: false,
    });
    expect(decision).toEqual({ clearSnapshot: true, action: 'navigator' });
  });

  test('null snapshot with a valid lastOpenedProject restores it', () => {
    const decision = bootRestoreDecision({
      pendingRestore: null,
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: existsIn(['/projects/last']),
      urlLaunch: false,
    });
    expect(decision).toEqual({
      clearSnapshot: false,
      action: 'lastOpened',
      project: '/projects/last',
    });
  });

  test('null snapshot with no lastOpenedProject opens the navigator without clearing', () => {
    const decision = bootRestoreDecision({
      pendingRestore: null,
      lastOpenedProject: null,
      optionHeld: false,
      pathExists: existsIn([]),
      urlLaunch: false,
    });
    expect(decision).toEqual({ clearSnapshot: false, action: 'navigator' });
  });

  test('null snapshot with a missing lastOpenedProject opens the navigator without clearing', () => {
    const decision = bootRestoreDecision({
      pendingRestore: null,
      lastOpenedProject: '/projects/gone',
      optionHeld: false,
      pathExists: existsIn([]),
      urlLaunch: false,
    });
    expect(decision).toEqual({ clearSnapshot: false, action: 'navigator' });
  });

  test('null snapshot with optionHeld suppresses lastOpened restore', () => {
    const decision = bootRestoreDecision({
      pendingRestore: null,
      lastOpenedProject: '/projects/last',
      optionHeld: true,
      pathExists: existsIn(['/projects/last']),
      urlLaunch: false,
    });
    expect(decision).toEqual({ clearSnapshot: false, action: 'navigator' });
  });

  // urlLaunch — a single-file deep-link (`ok <file>`) claims the launch, so the
  // boot path opens NO default window (the URL flush owns it).
  test('urlLaunch suppresses lastOpened restore (action none)', () => {
    const decision = bootRestoreDecision({
      pendingRestore: null,
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: existsIn(['/projects/last']),
      urlLaunch: true,
    });
    expect(decision).toEqual({ clearSnapshot: false, action: 'none' });
  });

  test('urlLaunch suppresses the Navigator when there is nothing to restore', () => {
    const decision = bootRestoreDecision({
      pendingRestore: null,
      lastOpenedProject: null,
      optionHeld: false,
      pathExists: existsIn([]),
      urlLaunch: true,
    });
    expect(decision).toEqual({ clearSnapshot: false, action: 'none' });
  });

  test('urlLaunch does NOT override a snapshot restore (snapshot wins)', () => {
    // A real update relaunch carries no deep-link, so this combo is theoretical
    // — but the restore must never be dropped, so the snapshot ranks above
    // urlLaunch.
    const decision = bootRestoreDecision({
      pendingRestore: [proj('/projects/a'), proj('/projects/b')],
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: existsIn(['/projects/a', '/projects/b']),
      urlLaunch: true,
    });
    expect(decision).toEqual({
      clearSnapshot: true,
      action: 'restore',
      windows: [proj('/projects/a'), proj('/projects/b')],
    });
  });
});

describe('resolveRestoreActions (file→project collapse + dedup ordering)', () => {
  // A resolver that maps loose files into projects per `fileToProject`, keeps
  // files in `ephemeral` as loose files, and rejects everything else (→ null,
  // the "vanished / non-markdown" skip that `prepareSingleFileOpen` throwing
  // produces in production).
  function resolverFrom(fileToProject: Record<string, string>, ephemeral: Set<string>) {
    return (filePath: string): RestoredWindow | null => {
      const root = fileToProject[filePath];
      if (root !== undefined) return proj(root);
      if (ephemeral.has(filePath)) return file(filePath);
      return null;
    };
  }

  test('project entries pass through unchanged, in order', () => {
    const { orderedKeys, actionByKey } = resolveRestoreActions(
      [proj('/a'), proj('/b')],
      () => null,
    );
    expect(orderedKeys).toEqual(['/a', '/b']);
    expect(actionByKey.get('/a')).toEqual(proj('/a'));
    expect(actionByKey.get('/b')).toEqual(proj('/b'));
  });

  test('a loose file staying ephemeral keeps its file key', () => {
    const { orderedKeys, actionByKey } = resolveRestoreActions(
      [file('/notes/todo.md')],
      resolverFrom({}, new Set(['/notes/todo.md'])),
    );
    expect(orderedKeys).toEqual(['/notes/todo.md']);
    expect(actionByKey.get('/notes/todo.md')).toEqual(file('/notes/todo.md'));
  });

  test('two loose files under one project collapse to a single project action', () => {
    const { orderedKeys, actionByKey } = resolveRestoreActions(
      [file('/proj/a.md'), file('/proj/b.md')],
      resolverFrom({ '/proj/a.md': '/proj', '/proj/b.md': '/proj' }, new Set()),
    );
    expect(orderedKeys).toEqual(['/proj']);
    expect(actionByKey.size).toBe(1);
    expect(actionByKey.get('/proj')).toEqual(proj('/proj'));
  });

  test('a loose file resolving into an already-present project entry collapses', () => {
    const { orderedKeys, actionByKey } = resolveRestoreActions(
      [proj('/proj'), file('/proj/inner.md')],
      resolverFrom({ '/proj/inner.md': '/proj' }, new Set()),
    );
    expect(orderedKeys).toEqual(['/proj']);
    expect(actionByKey.size).toBe(1);
    expect(actionByKey.get('/proj')).toEqual(proj('/proj'));
  });

  test('the LATER (more-recent) duplicate wins position so the raise target is last', () => {
    // /proj appears first (as a project), then again via a later loose file that
    // re-derives to it — the collapsed entry must move to the END so the
    // most-recently-focused window is the one raised.
    const { orderedKeys } = resolveRestoreActions(
      [proj('/proj'), proj('/other'), file('/proj/inner.md')],
      resolverFrom({ '/proj/inner.md': '/proj' }, new Set()),
    );
    expect(orderedKeys).toEqual(['/other', '/proj']);
  });

  test('a file the resolver rejects (null) is skipped silently', () => {
    const { orderedKeys, actionByKey } = resolveRestoreActions(
      [proj('/a'), file('/gone.md'), proj('/b')],
      resolverFrom({}, new Set()),
    );
    expect(orderedKeys).toEqual(['/a', '/b']);
    expect(actionByKey.has('/gone.md')).toBe(false);
  });

  test('empty snapshot → empty result', () => {
    const { orderedKeys, actionByKey } = resolveRestoreActions([], () => null);
    expect(orderedKeys).toEqual([]);
    expect(actionByKey.size).toBe(0);
  });
});


import { describe, expect, test } from 'bun:test';
import { SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';
import {
  ACTIVITY_MOUNT_LIMIT,
  computeActivityMountList,
  computeEditorMountGate,
  EditorActivityPool,
  getServerRestartRecoveryView,
  LARGE_DOC_CHAR_THRESHOLD,
  shouldEmitFirstToggle,
} from './EditorActivityPool';

interface FakeEntry {
  docName: string;
  lastAccessedAt: number;
}

const entry = (docName: string, lastAccessedAt: number): FakeEntry => ({
  docName,
  lastAccessedAt,
});

describe('ACTIVITY_MOUNT_LIMIT', () => {
  test('is 3 — matches SPEC.md §10 DX9', () => {
    expect(ACTIVITY_MOUNT_LIMIT).toBe(3);
  });

  test('is strictly less than ProviderPool MAX_POOL=10 (decoupling invariant)', () => {
    expect(ACTIVITY_MOUNT_LIMIT).toBeLessThan(10);
  });
});

describe('EditorActivityPool module contract', () => {
  test('default export is a function (React component)', () => {
    expect(typeof EditorActivityPool).toBe('function');
  });
});

describe('getServerRestartRecoveryView', () => {
  test('idle state does not replace the editor', () => {
    expect(getServerRestartRecoveryView('Untitled', { kind: 'idle' })).toBeNull();
  });

  test('recovering active doc uses server-restart copy instead of generic load copy', () => {
    const view = getServerRestartRecoveryView('Untitled', {
      kind: 'recovering',
      phase: 'clearing-local-cache',
      docNames: ['Untitled'],
      failedDocNames: [],
      startedAt: 1,
    });

    expect(view?.kind).toBe('recovering');
    expect(view?.title).toBe('Reconnecting after server restart');
    expect(view?.summary).toContain('Untitled');
    expect(view?.summary).not.toMatch(/connection|took too long/i);
  });

  test('failed active doc gets a targeted reload recovery surface', () => {
    const view = getServerRestartRecoveryView('Untitled', {
      kind: 'failed',
      reason: 'clear-data-timeout',
      docNames: ['Untitled'],
      failedDocNames: ['Untitled'],
      startedAt: 1,
    });

    expect(view?.kind).toBe('failed');
    expect(view?.title).toBe("Couldn't reconnect after server restart");
    expect(view?.summary).toMatch(/cleared in time/i);
    expect(view && 'actionLabel' in view ? view.actionLabel : null).toBe('Reload');
  });

  test('recovery state for another doc leaves this doc alone', () => {
    expect(
      getServerRestartRecoveryView('Healthy', {
        kind: 'recovering',
        phase: 'reconnecting',
        docNames: ['Untitled'],
        failedDocNames: [],
        startedAt: 1,
      }),
    ).toBeNull();
  });
});

describe('computeActivityMountList — basic sizing', () => {
  test('empty entries → empty list', () => {
    expect(computeActivityMountList([], null, 3)).toEqual([]);
    expect(computeActivityMountList([], 'doc-a', 3)).toEqual([]);
  });

  test('single entry → singleton list (regardless of active state)', () => {
    const a = entry('a', 100);
    expect(computeActivityMountList([a], 'a', 3)).toEqual([a]);
    expect(computeActivityMountList([a], null, 3)).toEqual([a]);
  });

  test('limit=0 → empty list (defensive — caller should not pass 0 but should not crash)', () => {
    const a = entry('a', 100);
    expect(computeActivityMountList([a], 'a', 0)).toEqual([]);
  });

  test('limit=-1 → empty list (defensive)', () => {
    const a = entry('a', 100);
    expect(computeActivityMountList([a], 'a', -1)).toEqual([]);
  });
});

describe('computeActivityMountList — MRU sorting', () => {
  test('returns entries sorted by lastAccessedAt descending', () => {
    const a = entry('a', 100);
    const b = entry('b', 300);
    const c = entry('c', 200);
    const result = computeActivityMountList([a, b, c], 'b', 3);
    expect(result.map((e) => e.docName)).toEqual(['b', 'c', 'a']);
  });

  test('is independent of input order — re-sorts internally', () => {
    const a = entry('a', 100);
    const b = entry('b', 300);
    const c = entry('c', 200);
    expect(computeActivityMountList([a, b, c], null, 3).map((e) => e.docName)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(computeActivityMountList([c, a, b], null, 3).map((e) => e.docName)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(computeActivityMountList([b, a, c], null, 3).map((e) => e.docName)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });
});

describe('computeActivityMountList — limit bounding', () => {
  test('4 entries with limit=3 → top 3 by lastAccessedAt', () => {
    const a = entry('a', 100);
    const b = entry('b', 200);
    const c = entry('c', 300);
    const d = entry('d', 400);
    const result = computeActivityMountList([a, b, c, d], 'd', 3);
    expect(result.map((e) => e.docName)).toEqual(['d', 'c', 'b']);
  });

  test('10 entries with limit=3 → top 3', () => {
    const entries: FakeEntry[] = Array.from({ length: 10 }, (_, i) => entry(`doc${i}`, i * 10));
    const result = computeActivityMountList(entries, 'doc9', 3);
    expect(result.map((e) => e.docName)).toEqual(['doc9', 'doc8', 'doc7']);
  });

  test('exactly limit entries → returns all of them', () => {
    const a = entry('a', 100);
    const b = entry('b', 200);
    const c = entry('c', 300);
    const result = computeActivityMountList([a, b, c], 'c', 3);
    expect(result).toHaveLength(3);
  });
});

describe('computeActivityMountList — active-doc force-inclusion (invariant #2)', () => {
  test('active doc not in top-N is force-included by displacing LRU', () => {
    const a = entry('a', 50); // active but oldest
    const b = entry('b', 200);
    const c = entry('c', 300);
    const d = entry('d', 400);
    const result = computeActivityMountList([a, b, c, d], 'a', 3);
    const names = result.map((e) => e.docName);
    expect(names).toContain('a');
    expect(result).toHaveLength(3);
    expect(names).toContain('d');
    expect(names).toContain('c');
    expect(names).not.toContain('b');
  });

  test('active doc absent from entries → top-N ignored (no fabrication)', () => {
    const a = entry('a', 100);
    const b = entry('b', 200);
    const result = computeActivityMountList([a, b], 'nonexistent', 3);
    expect(result.map((e) => e.docName)).toEqual(['b', 'a']);
  });

  test('active doc already in top-N → no displacement', () => {
    const a = entry('a', 100);
    const b = entry('b', 200);
    const c = entry('c', 300);
    const d = entry('d', 400);
    const result = computeActivityMountList([a, b, c, d], 'c', 3);
    expect(result.map((e) => e.docName)).toEqual(['d', 'c', 'b']);
  });

  test('null activeDocName → just top-N, no force-include', () => {
    const a = entry('a', 100);
    const b = entry('b', 200);
    const c = entry('c', 300);
    const d = entry('d', 400);
    const result = computeActivityMountList([a, b, c, d], null, 3);
    expect(result.map((e) => e.docName)).toEqual(['d', 'c', 'b']);
  });
});

describe('LARGE_DOC_CHAR_THRESHOLD', () => {
  test('is 500_000 — matches SPEC D12 DIRECTED + evidence/s1-diagnosis.md', () => {
    expect(LARGE_DOC_CHAR_THRESHOLD).toBe(500_000);
  });

  test('is safely above CLAUDE.md-class docs (≈150 KB) so they pre-mount both', () => {
    expect(LARGE_DOC_CHAR_THRESHOLD).toBeGreaterThan(200_000);
  });

  test('is safely below PROJECT.md-class docs (≥3 MB) so they trigger defer-mount', () => {
    expect(LARGE_DOC_CHAR_THRESHOLD).toBeLessThan(1_000_000);
  });
});

describe('computeEditorMountGate — small doc (below threshold)', () => {
  test('pre-mounts both regardless of mode or visit history (precedent #18(b) default)', () => {
    const small = 5583;
    const cases = [
      { isSourceMode: false, visitedSource: false, visitedVisual: true },
      { isSourceMode: true, visitedSource: true, visitedVisual: false },
      { isSourceMode: false, visitedSource: false, visitedVisual: false },
    ];
    for (const c of cases) {
      const gate = computeEditorMountGate({ ytextLength: small, ...c });
      expect(gate.renderSource).toBe(true);
      expect(gate.renderVisual).toBe(true);
      expect(gate.isLarge).toBe(false);
    }
  });

  test('exactly at threshold → still below (< not <=)', () => {
    const gate = computeEditorMountGate({
      ytextLength: LARGE_DOC_CHAR_THRESHOLD,
      isSourceMode: false,
      visitedSource: false,
      visitedVisual: true,
    });
    expect(gate.isLarge).toBe(false);
    expect(gate.renderSource).toBe(true);
    expect(gate.renderVisual).toBe(true);
  });

  test('one above threshold → flips to large', () => {
    const gate = computeEditorMountGate({
      ytextLength: LARGE_DOC_CHAR_THRESHOLD + 1,
      isSourceMode: false,
      visitedSource: false,
      visitedVisual: true,
    });
    expect(gate.isLarge).toBe(true);
  });
});

describe('computeEditorMountGate — large doc (above threshold)', () => {
  const large = 3_250_000; // ≈ PROJECT.md

  test('cold load in Visual mode → only TiptapEditor mounted', () => {
    const gate = computeEditorMountGate({
      ytextLength: large,
      isSourceMode: false,
      visitedSource: false, // never visited source
      visitedVisual: true, // initialized to true (active)
    });
    expect(gate.renderSource).toBe(false); // defer SourceEditor
    expect(gate.renderVisual).toBe(true);
    expect(gate.isLarge).toBe(true);
  });

  test('cold load in Source mode → only SourceEditor mounted', () => {
    const gate = computeEditorMountGate({
      ytextLength: large,
      isSourceMode: true,
      visitedSource: true, // active
      visitedVisual: false, // never visited visual
    });
    expect(gate.renderSource).toBe(true);
    expect(gate.renderVisual).toBe(false); // defer TiptapEditor
    expect(gate.isLarge).toBe(true);
  });

  test('after first toggle to Source → both mount', () => {
    const gate = computeEditorMountGate({
      ytextLength: large,
      isSourceMode: true,
      visitedSource: true,
      visitedVisual: true, // visited before
    });
    expect(gate.renderSource).toBe(true);
    expect(gate.renderVisual).toBe(true);
  });

  test('after first toggle to Visual → both mount', () => {
    const gate = computeEditorMountGate({
      ytextLength: large,
      isSourceMode: false,
      visitedSource: true, // visited before
      visitedVisual: true,
    });
    expect(gate.renderSource).toBe(true);
    expect(gate.renderVisual).toBe(true);
  });

  test('active mode is always rendered — defer never applies to active', () => {
    const gate = computeEditorMountGate({
      ytextLength: large,
      isSourceMode: true,
      visitedSource: false, // impossible in practice but we assert robustness
      visitedVisual: false,
    });
    expect(gate.renderSource).toBe(true); // active wins
    expect(gate.renderVisual).toBe(false);
  });

  test('threshold override respected (for test isolation)', () => {
    const small = 5583;
    const withDefault = computeEditorMountGate({
      ytextLength: small,
      isSourceMode: false,
      visitedSource: false,
      visitedVisual: true,
    });
    expect(withDefault.isLarge).toBe(false);
    const withOverride = computeEditorMountGate({
      ytextLength: small,
      isSourceMode: false,
      visitedSource: false,
      visitedVisual: true,
      threshold: 1000,
    });
    expect(withOverride.isLarge).toBe(true);
    expect(withOverride.renderSource).toBe(false); // defer source (not active, not visited)
    expect(withOverride.renderVisual).toBe(true); // active
  });
});

describe('computeEditorMountGate — invariant: at least one editor rendered', () => {
  test('small doc — always both', () => {
    const gate = computeEditorMountGate({
      ytextLength: 100,
      isSourceMode: false,
      visitedSource: false,
      visitedVisual: false,
    });
    expect(gate.renderSource || gate.renderVisual).toBe(true);
  });

  test('large doc — at least active is rendered', () => {
    for (const isSourceMode of [false, true]) {
      for (const visitedSource of [false, true]) {
        for (const visitedVisual of [false, true]) {
          const gate = computeEditorMountGate({
            ytextLength: 3_000_000,
            isSourceMode,
            visitedSource,
            visitedVisual,
          });
          expect(gate.renderSource || gate.renderVisual).toBe(true);
        }
      }
    }
  });
});


describe('shouldEmitFirstToggle — first-toggle mark gate', () => {
  test('large doc, both editors rendering, not yet emitted → emit', () => {
    expect(
      shouldEmitFirstToggle({
        isLarge: true,
        renderSource: true,
        renderVisual: true,
        hasEmittedFirstToggle: false,
      }),
    ).toBe(true);
  });

  test('large doc, both rendering, already emitted → do NOT emit (one-shot per Activity)', () => {
    expect(
      shouldEmitFirstToggle({
        isLarge: true,
        renderSource: true,
        renderVisual: true,
        hasEmittedFirstToggle: true,
      }),
    ).toBe(false);
  });

  test('large doc, only source rendering (initial cold load in source mode) → do NOT emit', () => {
    expect(
      shouldEmitFirstToggle({
        isLarge: true,
        renderSource: true,
        renderVisual: false,
        hasEmittedFirstToggle: false,
      }),
    ).toBe(false);
  });

  test('large doc, only visual rendering (initial cold load in visual mode) → do NOT emit', () => {
    expect(
      shouldEmitFirstToggle({
        isLarge: true,
        renderSource: false,
        renderVisual: true,
        hasEmittedFirstToggle: false,
      }),
    ).toBe(false);
  });

  test('small doc with both editors mounted (default pre-mount-both) → do NOT emit (AC 3)', () => {
    expect(
      shouldEmitFirstToggle({
        isLarge: false,
        renderSource: true,
        renderVisual: true,
        hasEmittedFirstToggle: false,
      }),
    ).toBe(false);
  });

  test('small doc, both rendered, already emitted (impossible in production but safe) → do NOT emit', () => {
    expect(
      shouldEmitFirstToggle({
        isLarge: false,
        renderSource: true,
        renderVisual: true,
        hasEmittedFirstToggle: true,
      }),
    ).toBe(false);
  });
});

describe('computeActivityMountList — system doc filtering (DX7 defense-in-depth)', () => {
  test('__system__ doc filtered out even if present in entries', () => {
    const sys = entry(SYSTEM_DOC_NAME, 999);
    const a = entry('a', 100);
    const result = computeActivityMountList([sys, a], 'a', 3);
    expect(result.map((e) => e.docName)).not.toContain(SYSTEM_DOC_NAME);
    expect(result.map((e) => e.docName)).toEqual(['a']);
  });

  test('__system__ never force-included even when set as activeDocName', () => {
    const sys = entry(SYSTEM_DOC_NAME, 100);
    const a = entry('a', 50);
    const result = computeActivityMountList([sys, a], SYSTEM_DOC_NAME, 3);
    expect(result.map((e) => e.docName)).not.toContain(SYSTEM_DOC_NAME);
  });
});

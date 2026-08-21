import { describe, expect, test } from 'vitest';
import { computeStickyRepinLayout } from './editor-area-sticky-repin';

describe('computeStickyRepinLayout', () => {
  test('pins a single pixel panel and gives the residual panel the rest (editor | doc)', () => {
    const next = computeStickyRepinLayout({
      currentLayout: { editor: 70, 'doc-panel': 30 },
      containerPx: 1000,
      pinnedPx: { 'doc-panel': 300 },
      residualId: 'editor',
    });
    expect(next['doc-panel']).toBeCloseTo(30, 6);
    expect(next.editor).toBeCloseTo(70, 6);
    expect(next.editor + next['doc-panel']).toBeCloseTo(100, 6);
  });

  test('pins two pixel panels; the residual (editor) absorbs the delta (editor | doc | terminal)', () => {
    const next = computeStickyRepinLayout({
      currentLayout: { editor: 40, 'doc-panel': 25, 'agents-column': 35 },
      containerPx: 1000,
      pinnedPx: { 'doc-panel': 300, 'agents-column': 400 },
      residualId: 'editor',
    });
    expect(next['doc-panel']).toBeCloseTo(30, 6);
    expect(next['agents-column']).toBeCloseTo(40, 6);
    expect(next.editor).toBeCloseTo(30, 6);
    expect(next.editor + next['doc-panel'] + next['agents-column']).toBeCloseTo(100, 6);
  });

  test('holds a collapsed doc panel at 0% and pins the terminal; editor absorbs (the VM scenario)', () => {
    // editor | doc(collapsed=0) | terminal after a left-sidebar collapse widened
    // the container. Only the terminal is pinned (the collapsed doc is left as-is);
    // the editor must absorb the freed width, not the terminal.
    const next = computeStickyRepinLayout({
      currentLayout: { editor: 20, 'doc-panel': 0, 'agents-column': 80 },
      containerPx: 1000,
      pinnedPx: { 'agents-column': 400 },
      residualId: 'editor',
    });
    expect(next['agents-column']).toBeCloseTo(40, 6);
    expect(next['doc-panel']).toBe(0);
    expect(next.editor).toBeCloseTo(60, 6);
  });

  test('preserves a non-pinned, non-residual panel in the layout', () => {
    // A layout can carry a member that is neither pinned nor the
    // residual — its share must pass through untouched while the residual
    // absorbs only what the pins leave.
    const next = computeStickyRepinLayout({
      currentLayout: { editor: 30, 'doc-panel': 20, 'agent-panel': 15, 'agents-column': 35 },
      containerPx: 1000,
      pinnedPx: { 'doc-panel': 250, 'agents-column': 350 },
      residualId: 'editor',
    });
    expect(next['doc-panel']).toBeCloseTo(25, 6);
    expect(next['agents-column']).toBeCloseTo(35, 6);
    expect(next['agent-panel']).toBeCloseTo(15, 6);
    expect(next.editor).toBeCloseTo(25, 6);
  });

  test('pins a collapse: pinning a panel at 0px holds it shut while the residual absorbs', () => {
    // The panel-set-change assert pins the doc panel at 0px to preserve a
    // user's collapse across a terminal mount/unmount layout restore.
    const next = computeStickyRepinLayout({
      currentLayout: { editor: 70, 'doc-panel': 30 },
      containerPx: 1000,
      pinnedPx: { 'doc-panel': 0 },
      residualId: 'editor',
    });
    expect(next['doc-panel']).toBe(0);
    expect(next.editor).toBeCloseTo(100, 6);
  });

  test('preserves peer key order and passes an unpinned peer through', () => {
    // editor | doc-panel | terminal-column | agents-column, with the terminal
    // column unpinned. The returned layout must keep the same key order (the
    // library has no ordering prop — source/DOM order is the contract) and pass
    // the unpinned terminal's share through unchanged.
    const currentLayout = {
      editor: 40,
      'doc-panel': 20,
      'terminal-column': 20,
      'agents-column': 20,
    };
    const next = computeStickyRepinLayout({
      currentLayout,
      containerPx: 1000,
      pinnedPx: { 'doc-panel': 300, 'agents-column': 200 },
      residualId: 'editor',
    });
    expect(Object.keys(next)).toEqual(['editor', 'doc-panel', 'terminal-column', 'agents-column']);
    expect(next['terminal-column']).toBeCloseTo(20, 6);
    expect(next['doc-panel']).toBeCloseTo(30, 6);
    expect(next['agents-column']).toBeCloseTo(20, 6);
    expect(next.editor).toBeCloseTo(30, 6);
  });

  test('expands one rail column while its hidden neighbour stays shut (editor pays)', () => {
    // Both rail columns are permanent members of the group, so a hidden one is
    // a zero-width peer rather than an absent panel. Showing the terminal must
    // take its width from the editor: the panel API cannot do this, because
    // `expand()`/`resize()` trade with the ADJACENT separator, and the adjacent
    // agents column has nothing to give at zero width.
    const next = computeStickyRepinLayout({
      currentLayout: { editor: 70, 'doc-panel': 30, 'terminal-column': 0, 'agents-column': 0 },
      containerPx: 2000,
      pinnedPx: { 'terminal-column': 740, 'agents-column': 0 },
      residualId: 'editor',
    });
    expect(next['terminal-column']).toBeCloseTo(37, 6);
    expect(next['agents-column']).toBe(0);
    expect(next['doc-panel']).toBeCloseTo(30, 6);
    expect(next.editor).toBeCloseTo(33, 6);
  });

  test('hiding a rail column returns its width to the editor, not the other rail', () => {
    const next = computeStickyRepinLayout({
      currentLayout: {
        editor: 23,
        'doc-panel': 15,
        'terminal-column': 37,
        'agents-column': 25,
      },
      containerPx: 2000,
      pinnedPx: { 'terminal-column': 0, 'agents-column': 500 },
      residualId: 'editor',
    });
    expect(next['terminal-column']).toBe(0);
    expect(next['agents-column']).toBeCloseTo(25, 6);
    expect(next.editor).toBeCloseTo(60, 6);
  });

  test('is a no-op when the container has no measurable width', () => {
    const input = { editor: 60, 'doc-panel': 40 };
    expect(
      computeStickyRepinLayout({
        currentLayout: input,
        containerPx: 0,
        pinnedPx: { 'doc-panel': 300 },
        residualId: 'editor',
      }),
    ).toBe(input);
  });

  test('is a no-op when the residual panel id is absent from the layout', () => {
    const input = { 'doc-panel': 40, 'agents-column': 60 };
    expect(
      computeStickyRepinLayout({
        currentLayout: input,
        containerPx: 1000,
        pinnedPx: { 'doc-panel': 300 },
        residualId: 'editor',
      }),
    ).toBe(input);
  });

  test('is a no-op when the pins cannot fit (residual would be negative)', () => {
    const input = { editor: 50, 'doc-panel': 25, 'agents-column': 25 };
    expect(
      computeStickyRepinLayout({
        currentLayout: input,
        containerPx: 1000,
        pinnedPx: { 'doc-panel': 600, 'agents-column': 600 },
        residualId: 'editor',
      }),
    ).toBe(input);
  });

  test('ignores pins for panels not present in the layout', () => {
    const next = computeStickyRepinLayout({
      currentLayout: { editor: 70, 'doc-panel': 30 },
      containerPx: 1000,
      pinnedPx: { 'doc-panel': 300, 'agents-column': 400 },
      residualId: 'editor',
    });
    expect('agents-column' in next).toBe(false);
    expect(next['doc-panel']).toBeCloseTo(30, 6);
    expect(next.editor).toBeCloseTo(70, 6);
  });
});

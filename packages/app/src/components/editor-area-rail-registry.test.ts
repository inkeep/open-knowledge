import { describe, expect, test } from 'vitest';
import {
  AGENTS_COLUMN_ID,
  accountRailLayout,
  DOC_PANEL_ID,
  findResidualPanelId,
  isRightRailPanelId,
  RIGHT_RAIL_PANEL_ORDER,
  TERMINAL_COLUMN_ID,
} from './editor-area-rail-registry';

// Stands in for the id-less editor panel: react-resizable-panels auto-generates
// an id for the panel that declares none, and it is the one id the rail
// accounting must resolve as the residual absorber.
const EDITOR = 'editor-residual';

/** Every subset of the input, each subset in the input's own order. */
function powerset<T>(items: readonly T[]): T[][] {
  let result: T[][] = [[]];
  for (const item of items) {
    const next: T[][] = [];
    for (const subset of result) {
      next.push(subset);
      next.push(subset.concat(item));
    }
    result = next;
  }
  return result;
}

describe('right-rail panel registry', () => {
  // Pins membership AND order. Dropping a peer (e.g. the terminal column) or
  // reordering fails here — a rendered column that is not registered would be
  // mistaken for the residual editor and silently consume its width.
  test('registers exactly the three rail peers in canonical order', () => {
    expect([...RIGHT_RAIL_PANEL_ORDER]).toEqual([
      DOC_PANEL_ID,
      TERMINAL_COLUMN_ID,
      AGENTS_COLUMN_ID,
    ]);
  });

  test('recognizes every registered id and rejects the editor', () => {
    for (const id of RIGHT_RAIL_PANEL_ORDER) {
      expect(isRightRailPanelId(id)).toBe(true);
    }
    expect(isRightRailPanelId(EDITOR)).toBe(false);
  });
});

describe('residual editor discovery across reachable layouts', () => {
  // The mechanical invariant: for every combination of rail peers (the
  // registry's powerset) plus the editor, the residual resolves to exactly the
  // editor and every present peer is accounted for. Adding a peer to the
  // registry automatically widens this sweep, so the accounting can never fall
  // behind the membership set.
  test('resolves exactly the editor and accounts for every peer in all combinations', () => {
    for (const peers of powerset(RIGHT_RAIL_PANEL_ORDER)) {
      const layout = [EDITOR, ...peers];
      expect(findResidualPanelId(layout)).toBe(EDITOR);
      const accounting = accountRailLayout(layout);
      expect(accounting.ok).toBe(true);
      expect(accounting.residualId).toBe(EDITOR);
      expect(accounting.presentPeers).toEqual(peers);
      expect(accounting.unaccountedIds).toEqual([]);
    }
  });

  test('accounts cleanly for the full rail', () => {
    const layout = [EDITOR, DOC_PANEL_ID, TERMINAL_COLUMN_ID, AGENTS_COLUMN_ID];
    const accounting = accountRailLayout(layout);
    expect(accounting.ok).toBe(true);
    expect(accounting.residualId).toBe(EDITOR);
    expect(accounting.presentPeers).toEqual([DOC_PANEL_ID, TERMINAL_COLUMN_ID, AGENTS_COLUMN_ID]);
  });

  test('accounts cleanly for a narrow rail (agents closed)', () => {
    const layout = [EDITOR, DOC_PANEL_ID, TERMINAL_COLUMN_ID];
    const accounting = accountRailLayout(layout);
    expect(accounting.ok).toBe(true);
    expect(accounting.residualId).toBe(EDITOR);
    expect(accounting.presentPeers).toEqual([DOC_PANEL_ID, TERMINAL_COLUMN_ID]);
  });
});

describe('the layout invariant fires on model defects', () => {
  // A column that renders WITHOUT joining the registry shows up as a second
  // non-peer id: the residual can no longer be resolved (two candidates), and
  // the accounting flags the stray id. This is the guard that stops a fourth
  // peer from degrading silently — the failure this whole model exists for.
  test('an unregistered rendered column breaks residual resolution and accounting', () => {
    const layout = [EDITOR, DOC_PANEL_ID, 'ghost-column'];
    expect(findResidualPanelId(layout)).toBeNull();
    const accounting = accountRailLayout(layout);
    expect(accounting.ok).toBe(false);
    expect(accounting.unaccountedIds).toContain('ghost-column');
  });

  // A layout where every id is a registered peer has no residual — the editor
  // column has been dropped from the accounting, also a defect.
  test('a layout missing the residual editor fails the invariant', () => {
    const layout = [DOC_PANEL_ID, AGENTS_COLUMN_ID];
    expect(findResidualPanelId(layout)).toBeNull();
    expect(accountRailLayout(layout).ok).toBe(false);
  });
});

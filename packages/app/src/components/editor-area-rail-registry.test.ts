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

const EDITOR = 'editor-residual';

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
  test('an unregistered rendered column breaks residual resolution and accounting', () => {
    const layout = [EDITOR, DOC_PANEL_ID, 'ghost-column'];
    expect(findResidualPanelId(layout)).toBeNull();
    const accounting = accountRailLayout(layout);
    expect(accounting.ok).toBe(false);
    expect(accounting.unaccountedIds).toContain('ghost-column');
  });

  test('a layout missing the residual editor fails the invariant', () => {
    const layout = [DOC_PANEL_ID, AGENTS_COLUMN_ID];
    expect(findResidualPanelId(layout)).toBeNull();
    expect(accountRailLayout(layout).ok).toBe(false);
  });
});

export const DOC_PANEL_ID = 'doc-panel';
export const TERMINAL_COLUMN_ID = 'terminal-column';
export const AGENTS_COLUMN_ID = 'agents-column';

export const RIGHT_RAIL_PANEL_ORDER = [DOC_PANEL_ID, TERMINAL_COLUMN_ID, AGENTS_COLUMN_ID] as const;

export type RightRailPanelId = (typeof RIGHT_RAIL_PANEL_ORDER)[number];

const RIGHT_RAIL_PANEL_ID_SET: ReadonlySet<string> = new Set(RIGHT_RAIL_PANEL_ORDER);

export function isRightRailPanelId(id: string): id is RightRailPanelId {
  return RIGHT_RAIL_PANEL_ID_SET.has(id);
}

export function findResidualPanelId(layoutIds: Iterable<string>): string | null {
  let residual: string | null = null;
  let count = 0;
  for (const id of layoutIds) {
    if (isRightRailPanelId(id)) continue;
    residual = id;
    count += 1;
    if (count > 1) return null;
  }
  return count === 1 ? residual : null;
}

export interface RailLayoutAccounting {
  readonly residualId: string | null;
  readonly presentPeers: readonly RightRailPanelId[];
  readonly unaccountedIds: readonly string[];
  readonly ok: boolean;
}

export function accountRailLayout(layoutIds: Iterable<string>): RailLayoutAccounting {
  const ids = [...layoutIds];
  const residualId = findResidualPanelId(ids);
  const presentPeers = RIGHT_RAIL_PANEL_ORDER.filter((id) => ids.includes(id));
  const accounted = new Set<string>(presentPeers);
  if (residualId != null) accounted.add(residualId);
  const unaccountedIds = ids.filter((id) => !accounted.has(id));
  const ok = residualId != null && unaccountedIds.length === 0;
  return { residualId, presentPeers, unaccountedIds, ok };
}

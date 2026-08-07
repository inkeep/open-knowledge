/**
 * Single source of truth for the horizontal editor group's right-rail peer
 * identities. The editor column is the residual absorber and is deliberately
 * NOT a member: it carries no panel id and is identified by exclusion — the one
 * live layout id that is not a registered peer. Registering a rail column here
 * is what keeps it OUT of the residual slot; an unregistered column that renders
 * would be mistaken for the editor and consume its width, with no error.
 *
 * `assertRightRailLayout` and every rail-accounting site read membership and
 * order from here rather than re-encoding the id set, so a new peer joins the
 * rail by being added to `RIGHT_RAIL_PANEL_ORDER` alone.
 */

// String literals kept as `const` bindings (not `as const`) — a const binding
// of a string literal already narrows to its literal type, which the ordered
// tuple below relies on for `RightRailPanelId`.
export const DOC_PANEL_ID = 'doc-panel';
export const AGENT_PANEL_ID = 'agent-panel';
export const TERMINAL_COLUMN_ID = 'terminal-column';
export const AGENTS_COLUMN_ID = 'agents-column';

/**
 * Left-to-right order of the rail peers, after the residual editor column.
 * `doc-panel` and `agent-panel` share the rightPanel slot (never both present);
 * the terminal column sits between the document side pane and the agents column.
 */
export const RIGHT_RAIL_PANEL_ORDER = [
  DOC_PANEL_ID,
  AGENT_PANEL_ID,
  TERMINAL_COLUMN_ID,
  AGENTS_COLUMN_ID,
] as const;

export type RightRailPanelId = (typeof RIGHT_RAIL_PANEL_ORDER)[number];

const RIGHT_RAIL_PANEL_ID_SET: ReadonlySet<string> = new Set(RIGHT_RAIL_PANEL_ORDER);

export function isRightRailPanelId(id: string): id is RightRailPanelId {
  return RIGHT_RAIL_PANEL_ID_SET.has(id);
}

/**
 * The residual (editor) panel id in a live layout: the single id that is not a
 * registered rail peer. Returns null when the count is not exactly one — zero
 * means no residual to correct, more than one means an unregistered column is
 * rendering and would otherwise be mistaken for the editor. A correct layout
 * always yields exactly one, so the strictness turns the silent-degradation
 * failure into a no-op the caller can bail on rather than a mis-pinned rail.
 */
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

/**
 * Reconstruct the rail from a layout's ids: the residual editor plus every
 * present registered peer must exactly cover the layout. Any id left over — an
 * unregistered column, or a peer dropped from the accounting — makes `ok` false.
 * The guard the rail model is verified against.
 */
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

export const DOC_PANEL_ID = 'doc-panel';

export function findResidualPanelId(layoutIds: Iterable<string>): string | null {
  let residual: string | null = null;
  let count = 0;
  for (const id of layoutIds) {
    if (id === DOC_PANEL_ID) continue;
    residual = id;
    count += 1;
    if (count > 1) return null;
  }
  return count === 1 ? residual : null;
}

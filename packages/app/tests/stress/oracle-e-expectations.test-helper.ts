
export type OracleEOp =
  | { kind: 'wysiwyg-type'; marker: string }
  | { kind: 'source-type'; marker: string }
  | { kind: 'agent-write'; position: 'append' | 'prepend' | 'replace'; marker: string }
  | { kind: 'agent-patch'; find: string; replace: string; marker: string }
  | { kind: 'agent-undo' }
  | { kind: 'external-change'; marker: string }
  | { kind: 'chunked-source-paste'; marker: string }
  | { kind: 'jsx-block'; marker: string }
  | { kind: 'large-embed'; marker: string }
  | { kind: 'sync-pause' }
  | { kind: 'sync-resume' }
  | { kind: 'wait' };

export function markerPrefixOf(marker: string): string {
  const dashIdx = marker.indexOf('-');
  return dashIdx === -1 ? marker : marker.slice(0, dashIdx + 1);
}

export interface OracleEExpectations {
  preMarkerLines: Map<string, string>;
  patches: Array<{ find: string; replace: string }>;
}

export function buildOracleEExpectations(
  ops: readonly OracleEOp[],
  notAppliedOpIndices: ReadonlySet<number>,
): OracleEExpectations {
  const preMarkerLines = new Map<string, string>(); // prefix → pre-patch line
  const patches: Array<{ find: string; replace: string }> = [];
  for (let i = 0; i < ops.length; i++) {
    if (notAppliedOpIndices.has(i)) continue;
    const op = ops[i];
    if (op === undefined) continue;
    switch (op.kind) {
      case 'wysiwyg-type':
      case 'source-type':
        preMarkerLines.set(markerPrefixOf(op.marker), op.marker);
        break;
      case 'agent-write':
        if (op.position === 'replace') preMarkerLines.clear();
        preMarkerLines.set(markerPrefixOf(op.marker), op.marker);
        break;
      case 'agent-patch':
        patches.push({ find: op.find, replace: op.replace });
        break;
      case 'external-change':
        preMarkerLines.clear();
        preMarkerLines.set(markerPrefixOf(op.marker), op.marker);
        break;
      case 'agent-undo':
        preMarkerLines.clear();
        break;
    }
  }
  return { preMarkerLines, patches };
}

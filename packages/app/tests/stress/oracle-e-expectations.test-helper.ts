/**
 * Oracle (e) expectation walk for the bridge-convergence fuzz harness —
 * extracted from bridge-convergence.fuzz.test.ts so the walk's accounting
 * contract is unit-pinnable (the fuzz test is the only other consumer).
 *
 * CONTRACT: the walk builds the set of marker lines whose content oracle (e)
 * demands in every client's final state. An op the harness main loop recorded
 * as NOT APPLIED (e.g. an agent write the server legitimately refused with
 * 409 doc-in-conflict — `applyOp` returned false) never touched the doc, so
 * its marker MUST NOT contribute to the expectations: demanding the marker of
 * a refused write makes oracle (e) fail with a misleading "tail corruption"
 * message on runs where nothing was corrupted. This mirrors the main loop's
 * own `if (!applied) continue;` bookkeeping that oracles (d) and the
 * expected-body tracker already honor — the two walks must not disagree on
 * which ops count.
 */

/** Structural slice of the fuzz harness's `Op` union that the walk reads. */
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

/**
 * Marker format is `M<N>-<words>`; the durable `M<N>-` prefix keys oracle
 * bookkeeping (agent-patch's WORDS-pool find/replace can mutate the tail but
 * never produces a valid `M<N>-` prefix).
 */
export function markerPrefixOf(marker: string): string {
  const dashIdx = marker.indexOf('-');
  return dashIdx === -1 ? marker : marker.slice(0, dashIdx + 1);
}

export interface OracleEExpectations {
  /** prefix → pre-patch line form for every content-producing marker. */
  preMarkerLines: Map<string, string>;
  /** Every agent-patch's (find, replace) pair, in op order. */
  patches: Array<{ find: string; replace: string }>;
}

/**
 * Walk the generated op sequence and build oracle (e)'s expectations.
 *
 * @param ops - the FULL generated op list, in execution order.
 * @param notAppliedOpIndices - indices into `ops` of operations the main loop
 *   observed as not applied (refused/failed — `applyOp` returned false).
 *   Markers of these ops must be excluded from the returned expectations.
 */
export function buildOracleEExpectations(
  ops: readonly OracleEOp[],
  notAppliedOpIndices: ReadonlySet<number>,
): OracleEExpectations {
  const preMarkerLines = new Map<string, string>(); // prefix → pre-patch line
  const patches: Array<{ find: string; replace: string }> = [];
  for (let i = 0; i < ops.length; i++) {
    // A not-applied op never touched the doc: skip BOTH its marker
    // registration and its side effects (replace/external-change clears,
    // agent-undo's conservative clear) — none of them may shape the
    // expectations.
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
        // Conservatively clear — undo may remove any prior agent-write.
        preMarkerLines.clear();
        break;
      // chunked-source-paste: intentionally excluded — its marker is checked
      // by the harness's chunk-glue relaxation, not by this walk.
      // jsx-block / large-embed: intentionally excluded — the marker is embedded
      // in a multi-line construct (a <Steps>/<Step> body line, or an html-preview
      // <script>), so the per-marker single-line-form match here does not apply.
      // Their preservation is covered by the byte-budget / no-duplication oracle
      // and the integration seeds.
    }
  }
  return { preMarkerLines, patches };
}

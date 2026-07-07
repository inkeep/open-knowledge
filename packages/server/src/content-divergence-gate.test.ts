import { describe, expect, test } from 'bun:test';
import { ContentDivergenceWarningSchema } from '@inkeep/open-knowledge-core';
import {
  CONTENT_DIVERGENCE_CAP_BYTES,
  capContent,
  evaluateContentDivergence,
  toContentDivergenceWarning,
} from './content-divergence-gate.ts';

describe('content-divergence gate', () => {
  test('byte-equal content returns undefined (no divergence, the common path)', () => {
    expect(evaluateContentDivergence('same bytes', 'same bytes', 'replace')).toBeUndefined();
    expect(evaluateContentDivergence('', '', 'append')).toBeUndefined();
  });

  test('divergence carries the converged content inline + a coarse type', () => {
    const actual = '# Heading\n\nwhat actually landed\n';
    const intended = '# Heading\n\nwhat I intended\n';
    const d = evaluateContentDivergence(actual, intended, 'patch');
    expect(d).toBeDefined();
    if (!d) return;
    expect(d.intendedBytes).toBe(intended.length);
    expect(d.actualBytes).toBe(actual.length);
    expect(d.byteDelta).toBe(actual.length - intended.length);
    expect(d.divergenceType).toBe('patch-content-mismatch');
    // The whole point: the agent recovers from `currentState`, no re-read.
    expect(d.currentState).toEqual({ kind: 'inline', content: actual });
  });

  test('divergenceType label tracks the write surface', () => {
    expect(evaluateContentDivergence('a', 'b', 'replace')?.divergenceType).toBe(
      'replace-content-mismatch',
    );
    expect(evaluateContentDivergence('a', 'b', 'append')?.divergenceType).toBe(
      'append-content-mismatch',
    );
    expect(evaluateContentDivergence('a', 'b', 'rollback')?.divergenceType).toBe(
      'rollback-content-mismatch',
    );
  });

  test('byte fields are UTF-8 byte counts, not UTF-16 code units', () => {
    // 'é' = 1 code unit / 2 UTF-8 bytes; '😀' = 2 code units / 4 UTF-8 bytes.
    // 'abé😀' is string-length 5 but 8 UTF-8 bytes — the fields must report 8.
    const d = evaluateContentDivergence('abé😀', 'abc', 'replace');
    expect(d).toBeDefined();
    if (!d) return;
    expect(d.intendedBytes).toBe(3);
    expect(d.actualBytes).toBe(8);
    expect(d.byteDelta).toBe(5);
    expect(d.currentState).toEqual({ kind: 'inline', content: 'abé😀' });
  });

  test('capContent is inline at exactly the soft cap, truncated one byte over', () => {
    const atCap = 'x'.repeat(CONTENT_DIVERGENCE_CAP_BYTES);
    expect(capContent(atCap)).toEqual({ kind: 'inline', content: atCap });

    const overCap = 'x'.repeat(CONTENT_DIVERGENCE_CAP_BYTES + 1);
    const cs = capContent(overCap);
    expect(cs.kind).toBe('truncated');
    if (cs.kind === 'truncated') {
      expect(cs.byteLength).toBe(overCap.length);
      expect(cs.hint).toContain('exec');
      // The truncated variant carries no inline content (just a re-read marker).
      expect('content' in cs).toBe(false);
    }
  });

  test('an over-cap divergence degrades currentState to a truncation marker', () => {
    const actual = 'y'.repeat(CONTENT_DIVERGENCE_CAP_BYTES + 100);
    const d = evaluateContentDivergence(actual, 'small', 'replace');
    expect(d?.currentState.kind).toBe('truncated');
  });

  test('toContentDivergenceWarning maps the wire shape with a default hint', () => {
    const d = evaluateContentDivergence('actual', 'intended', 'replace');
    expect(d).toBeDefined();
    if (!d) return;
    const w = toContentDivergenceWarning(d);
    expect(w.kind).toBe('content-divergence');
    expect(w.intendedBytes).toBe(d.intendedBytes);
    expect(w.actualBytes).toBe(d.actualBytes);
    expect(w.byteDelta).toBe(d.byteDelta);
    expect(w.divergenceType).toBe('replace-content-mismatch');
    expect(w.currentState).toEqual(d.currentState);
    expect(typeof w.hint).toBe('string');
    expect(w.hint).toContain('currentState');
  });

  test('toContentDivergenceWarning accepts an explicit hint override', () => {
    const d = evaluateContentDivergence('a', 'b', 'replace');
    if (!d) return;
    expect(toContentDivergenceWarning(d, 'custom hint').hint).toBe('custom hint');
  });

  test('the wire schema round-trips a full warning (inline + truncated currentState)', () => {
    const small = evaluateContentDivergence('a', 'b', 'replace');
    const big = evaluateContentDivergence(
      'x'.repeat(CONTENT_DIVERGENCE_CAP_BYTES + 1),
      'b',
      'replace',
    );
    expect(small).toBeDefined();
    expect(big).toBeDefined();
    if (!small || !big) return;
    expect(
      ContentDivergenceWarningSchema.safeParse(toContentDivergenceWarning(small)).success,
    ).toBe(true);
    expect(ContentDivergenceWarningSchema.safeParse(toContentDivergenceWarning(big)).success).toBe(
      true,
    );
  });
});

/**
 * Deterministic pins for classifyFinalState — the budget-exhaustion
 * discriminator that turns a former unconditional fuzz failure into a
 * conditional converged-late pass. The fuzz suite only reaches it under
 * seed-dependent wall-clock exhaustion, so each of the three outcomes is
 * pinned here against hand-built client states: a future inversion of the
 * pass/fail decision reddens reliably instead of probabilistically.
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { classifyFinalState, serializeFragment } from './test-harness';

/** A minimal classifiable client: paragraph fragment + explicit Y.Text bytes. */
function makeClient(paragraphText: string, ytextBytes: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  ytext.insert(0, ytextBytes);
  const fragment = doc.getXmlFragment('default');
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, paragraphText);
  paragraph.insert(0, [text]);
  fragment.push([paragraph]);
  return { ytext, fragment };
}

describe('classifyFinalState', () => {
  test('diverged peers classify as stalled, never converged-late', () => {
    const a = makeClient('Alpha.', 'Alpha.\n');
    const b = makeClient('Alpha.', 'Beta.\n');
    const result = classifyFinalState([a, b]);
    expect(result.outcome).toBe('stalled');
    if (result.outcome === 'stalled') {
      expect(result.detail).toBe('peers diverged at budget exhaustion');
    }
  });

  test('identical peers beyond bridge tolerance classify as stalled', () => {
    const a = makeClient('Alpha.', 'Entirely different settled bytes.\n');
    const b = makeClient('Alpha.', 'Entirely different settled bytes.\n');
    const result = classifyFinalState([a, b]);
    expect(result.outcome).toBe('stalled');
    if (result.outcome === 'stalled') {
      expect(result.detail).toStartWith('bridge invariant beyond tolerance at budget exhaustion');
    }
  });

  test('identical, in-tolerance peers classify as converged-late', () => {
    const a = makeClient('Alpha.', 'Alpha.\n');
    const b = makeClient('Alpha.', 'Alpha.\n');
    // Sanity: the Y.Text bytes match the fragment's canonical serialization,
    // so this state is good — late, not wrong.
    expect(serializeFragment(a.fragment)).toBe('Alpha.\n');
    expect(classifyFinalState([a, b])).toEqual({ outcome: 'converged-late' });
  });
});

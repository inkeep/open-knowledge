import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { classifyFinalState, serializeFragment } from './test-harness';

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
      const prefix = 'bridge invariant beyond tolerance at budget exhaustion';
      expect(result.detail.slice(0, prefix.length)).toBe(prefix);
    }
  });

  test('identical, in-tolerance peers classify as converged-late', () => {
    const a = makeClient('Alpha.', 'Alpha.\n');
    const b = makeClient('Alpha.', 'Alpha.\n');
    expect(serializeFragment(a.fragment)).toBe('Alpha.\n');
    expect(classifyFinalState([a, b])).toEqual({ outcome: 'converged-late' });
  });
});

/**
 * The demand policy's whole job is to be wrong in only one direction.
 *
 * A wrong "yes" costs the derive we already pay today. A wrong "no" shows a
 * reader stale content in a surface they are actively looking at. These rows
 * pin the asymmetry — every unknown, malformed, or unrecognised peer state
 * must read as demanding.
 */
import { describe, expect, test } from 'vitest';
import { anyPeerNeedsFragment, type DemandAwarenessState } from './fragment-demand-policy.ts';

const SERVER = 1;
const states = (entries: Array<[number, DemandAwarenessState | undefined]>) =>
  new Map<number, DemandAwarenessState | undefined>(entries);

describe('anyPeerNeedsFragment', () => {
  test('nobody connected → no demand (the case the gate exists for)', () => {
    expect(anyPeerNeedsFragment(states([]), SERVER)).toBe(false);
  });

  test('every peer in source mode → no demand', () => {
    expect(
      anyPeerNeedsFragment(
        states([
          [2, { mode: 'source' }],
          [3, { mode: 'source' }],
        ]),
        SERVER,
      ),
    ).toBe(false);
  });

  test('one peer in WYSIWYG among source-mode peers → demand', () => {
    expect(
      anyPeerNeedsFragment(
        states([
          [2, { mode: 'source' }],
          [3, { mode: 'wysiwyg' }],
          [4, { mode: 'source' }],
        ]),
        SERVER,
      ),
    ).toBe(true);
  });

  test("the server's own entry is skipped — it publishes presence, it never reads the fragment", () => {
    // Without the skip this is indistinguishable from a connected WYSIWYG peer
    // and the gate could never close on a server that publishes agent presence.
    expect(anyPeerNeedsFragment(states([[SERVER, { mode: undefined }]]), SERVER)).toBe(false);
  });

  describe('fail-safe: anything not explicitly source mode demands a derive', () => {
    const cases: Array<[string, DemandAwarenessState | undefined]> = [
      ['no mode field at all (client predating the field)', {}],
      ['undefined state', undefined],
      ['mode explicitly undefined', { mode: undefined }],
      ['mode null', { mode: null }],
      ['unrecognised mode string', { mode: 'preview' }],
      ['mode of the wrong type', { mode: 1 }],
      ['near-miss casing', { mode: 'Source' }],
    ];
    for (const [label, state] of cases) {
      test(label, () => {
        expect(anyPeerNeedsFragment(states([[2, state]]), SERVER)).toBe(true);
      });
    }
  });
});

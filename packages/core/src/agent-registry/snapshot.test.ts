import { describe, expect, it } from 'vitest';
import { satisfierId } from './ids.ts';
import {
  EMPTY_DETECTION_SNAPSHOT,
  EMPTY_PROBE_SNAPSHOT,
  ENV_TIERS,
  isAgentDetected,
  type ProbeSnapshot,
  readSatisfierProbe,
} from './snapshot.ts';

const id = satisfierId({ agent: 'claude', piece: 'mcp', scope: 'project', kind: 'config-entry' });

const loose = (value: unknown) => value as ProbeSnapshot;

describe('reading one satisfier out of a snapshot', () => {
  it('returns the answer a host gave', () => {
    expect(
      readSatisfierProbe({ env: 'desktop', satisfiers: { [id]: { state: 'satisfied' } } }, id),
    ).toEqual({ state: 'satisfied' });
  });

  it('keeps the predicates that answered', () => {
    expect(
      readSatisfierProbe(
        {
          env: 'desktop',
          satisfiers: { [id]: { state: 'satisfied', strictness: ['pre-approval-exact'] } },
        },
        id,
      ),
    ).toEqual({ state: 'satisfied', strictness: ['pre-approval-exact'] });
  });

  it('reports no answer for a key the host left out', () => {
    expect(readSatisfierProbe(EMPTY_PROBE_SNAPSHOT, id)).toBeUndefined();
  });

  it('reports no answer rather than throwing on anything unusable', () => {
    const unusable = [
      undefined,
      null,
      'a string',
      42,
      {},
      { satisfiers: null },
      { satisfiers: 'nope' },
      { satisfiers: { [id]: null } },
      { satisfiers: { [id]: 'satisfied' } },
      { satisfiers: { [id]: {} } },
      { satisfiers: { [id]: { state: 42 } } },
      { satisfiers: { [id]: { state: '' } } },
    ];
    for (const value of unusable) {
      expect(readSatisfierProbe(loose(value), id)).toBeUndefined();
    }
  });

  it('drops a strictness list that did not survive the trip intact', () => {
    expect(
      readSatisfierProbe(
        loose({ satisfiers: { [id]: { state: 'satisfied', strictness: 7 } } }),
        id,
      ),
    ).toEqual({ state: 'satisfied' });
    expect(
      readSatisfierProbe(
        loose({ satisfiers: { [id]: { state: 'satisfied', strictness: ['ok', 5, null] } } }),
        id,
      ),
    ).toEqual({ state: 'satisfied', strictness: ['ok'] });
  });
});

describe('detection', () => {
  it('claims nothing when nobody looked', () => {
    expect(EMPTY_DETECTION_SNAPSHOT.probed).toBe(false);
    expect(isAgentDetected(EMPTY_DETECTION_SNAPSHOT, 'claude')).toBe(false);
  });

  it('separates a probe that ran and found nothing from one that never ran', () => {
    expect({ detected: [], probed: true }.probed).not.toBe(EMPTY_DETECTION_SNAPSHOT.probed);
  });

  it('answers for an agent a host proved present', () => {
    expect(isAgentDetected({ detected: ['claude', 'codex'], probed: true }, 'codex')).toBe(true);
    expect(isAgentDetected({ detected: ['claude'], probed: true }, 'codex')).toBe(false);
  });

  it('claims nothing on a malformed snapshot', () => {
    for (const value of [undefined, null, {}, { detected: 'claude' }]) {
      expect(isAgentDetected(value as never, 'claude')).toBe(false);
    }
  });
});

describe('environment tiers', () => {
  it('names only tiers an adapter can actually be in', () => {
    expect([...ENV_TIERS]).toEqual(['desktop', 'local-web', 'remote-web']);
  });
});

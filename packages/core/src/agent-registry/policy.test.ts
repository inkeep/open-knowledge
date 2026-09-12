import { describe, expect, it } from 'vitest';
import { AGENT_MODES } from './ids.ts';
import { MODE_GATE_POLICY, MODE_VISIBILITY_POLICY, STATE_POLICY } from './policy.ts';
import { KNOWN_SURFACE_STATES } from './vocabulary.ts';

describe('STATE_POLICY', () => {
  it('has exactly one row per known state', () => {
    expect(Object.keys(STATE_POLICY).sort()).toEqual([...KNOWN_SURFACE_STATES].sort());
  });

  it('carries counts and exception together on every row', () => {
    for (const state of KNOWN_SURFACE_STATES) {
      const row = STATE_POLICY[state];
      expect(typeof row.counts).toBe('boolean');
      expect(row.exception === null || ['info', 'warning', 'error'].includes(row.exception)).toBe(
        true,
      );
    }
  });

  it('lets an unknown-consent artifact count, and says so quietly', () => {
    expect(STATE_POLICY['present-consent-unknown']).toEqual({ counts: true, exception: 'info' });
  });

  it('credits what we declared unprobeable and withholds credit for what we never probed', () => {
    expect(STATE_POLICY.unprobeable.counts).toBe(true);
    expect(STATE_POLICY.unprobed.counts).toBe(false);
  });

  it('counts nothing else that is not actually in place', () => {
    const counting = KNOWN_SURFACE_STATES.filter((state) => STATE_POLICY[state].counts);
    expect([...counting].sort()).toEqual(
      ['present-consent-unknown', 'satisfied', 'unprobeable'].sort(),
    );
  });

  it('leaves an uninstalled agent unannotated rather than reading as a failure', () => {
    expect(STATE_POLICY.undetected.exception).toBeNull();
    expect(STATE_POLICY.absent.exception).toBeNull();
  });
});

describe('MODE_GATE_POLICY', () => {
  it('has one row per mode', () => {
    expect(Object.keys(MODE_GATE_POLICY).sort()).toEqual([...AGENT_MODES].sort());
  });

  it('resolves an unanswered probe by what being wrong would cost in that mode', () => {
    expect(MODE_GATE_POLICY.terminal.unprobed).toBe('count-unverified');
    expect(MODE_GATE_POLICY.acp.unprobed).toBe('count-unverified');
    expect(MODE_GATE_POLICY.external.unprobed).toBe('not-count');
  });
});

describe('MODE_VISIBILITY_POLICY', () => {
  it('has one row per mode, each naming its signal', () => {
    expect(Object.keys(MODE_VISIBILITY_POLICY).sort()).toEqual([...AGENT_MODES].sort());
    expect(MODE_VISIBILITY_POLICY.acp.signal).toBe('acp-catalog-supported');
    expect(MODE_VISIBILITY_POLICY.terminal.signal).toBe('harness-cli-on-path');
    expect(MODE_VISIBILITY_POLICY.external.signal).toBe('os-scheme-handler');
  });

  it('keeps terminal fail-open and external strict — they are deliberate opposites', () => {
    expect(MODE_VISIBILITY_POLICY.terminal.unresolved).toBe('show');
    expect(MODE_VISIBILITY_POLICY.external.unresolved).toBe('hide');
  });

  it('lets only an unrunnable in-app agent outrank the user override', () => {
    expect(MODE_VISIBILITY_POLICY.acp.negativeOutranksOverride).toBe(true);
    expect(MODE_VISIBILITY_POLICY.terminal.negativeOutranksOverride).toBe(false);
    expect(MODE_VISIBILITY_POLICY.external.negativeOutranksOverride).toBe(false);
  });
});

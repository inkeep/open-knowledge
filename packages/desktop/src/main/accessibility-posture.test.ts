/**
 * The one property this module exists for: a reading that did not happen must
 * not be indistinguishable from a reading that came back empty.
 *
 * Both are otherwise "nothing to see" — an empty flag array and a failed read
 * look identical the moment either is flattened to `[]`, and a responder
 * reading the bundle then cannot tell "no accessibility modes were active"
 * from "we could not ask". The crash-side sites draw the same distinction for
 * the mode read off a dump; these tests keep this side honest about it.
 */

import { describe, expect, test, vi } from 'vitest';
import {
  accessibilityPostureFacts,
  resolveAccessibilityFeatures,
} from './accessibility-posture.ts';

describe('resolveAccessibilityFeatures', () => {
  test('a real reading comes back as itself', () => {
    const onError = vi.fn();
    expect(resolveAccessibilityFeatures(() => ['nativeAPIs', 'webContents'], onError)).toEqual([
      'nativeAPIs',
      'webContents',
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  test('an EMPTY reading is a real answer, not a failure', () => {
    // The distinction the whole module turns on: Chromium answered, and the
    // answer was "no modes active". That must not become null.
    const onError = vi.fn();
    expect(resolveAccessibilityFeatures(() => [], onError)).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  test('an absent method reads as null, never as an empty array', () => {
    // An Electron older than the one that added the method. Flattening this to
    // `[]` would assert "no modes active" about a process we never asked.
    const onError = vi.fn();
    expect(resolveAccessibilityFeatures(undefined, onError)).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  test('a throwing method reads as null AND reports the error', () => {
    // A guard that swallows its error removes the only signal it ever fired,
    // which matters most here because this sits where a throw would otherwise
    // take a boot down.
    const onError = vi.fn();
    const boom = new Error('accessibility state unavailable');
    expect(
      resolveAccessibilityFeatures(() => {
        throw boom;
      }, onError),
    ).toBeNull();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  test('a throw does not escape to the caller', () => {
    // The invariant the guard exists for: this reading never propagates.
    expect(() =>
      resolveAccessibilityFeatures(
        () => {
          throw new Error('boom');
        },
        () => {},
      ),
    ).not.toThrow();
  });
});

describe('accessibilityPostureFacts', () => {
  const base = { phase: 'boot', supportEnabled: true, forcedByEnv: false } as const;

  test('a read flag set is carried verbatim', () => {
    expect(accessibilityPostureFacts({ ...base, features: ['screenReader'] })).toEqual({
      event: 'desktop.accessibility',
      phase: 'boot',
      supportEnabled: true,
      features: ['screenReader'],
      forcedByEnv: false,
    });
  });

  test('an empty flag set is PRESENT as an empty array', () => {
    // "We looked and nothing was active" is a finding, and it has to survive
    // onto the line as an empty array rather than vanishing.
    const facts = accessibilityPostureFacts({ ...base, features: [] });
    expect(facts).toHaveProperty('features');
    expect(facts.features).toEqual([]);
  });

  test('an unread flag set is ABSENT, not an empty array', () => {
    // The pair to the case above, and the reason the field is spread
    // conditionally. If this emitted `features: []` the two would be one line.
    expect(accessibilityPostureFacts({ ...base, features: null })).not.toHaveProperty('features');
  });

  test('the empty and unread cases do not produce the same line', () => {
    // Stated directly, so a future refactor that flattens null to `[]` fails
    // here rather than quietly in a bundle nobody can interpret.
    expect(accessibilityPostureFacts({ ...base, features: [] })).not.toEqual(
      accessibilityPostureFacts({ ...base, features: null }),
    );
  });

  test('the changed phase and the forced flag ride through', () => {
    expect(
      accessibilityPostureFacts({
        phase: 'changed',
        supportEnabled: false,
        features: null,
        forcedByEnv: true,
      }),
    ).toEqual({
      event: 'desktop.accessibility',
      phase: 'changed',
      supportEnabled: false,
      forcedByEnv: true,
    });
  });
});

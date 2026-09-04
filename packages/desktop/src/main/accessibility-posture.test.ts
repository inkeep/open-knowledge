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
    const onError = vi.fn();
    expect(resolveAccessibilityFeatures(() => [], onError)).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  test('an absent method reads as null, never as an empty array', () => {
    const onError = vi.fn();
    expect(resolveAccessibilityFeatures(undefined, onError)).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  test('a throwing method reads as null AND reports the error', () => {
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
    const facts = accessibilityPostureFacts({ ...base, features: [] });
    expect(facts).toHaveProperty('features');
    expect(facts.features).toEqual([]);
  });

  test('an unread flag set is ABSENT, not an empty array', () => {
    expect(accessibilityPostureFacts({ ...base, features: null })).not.toHaveProperty('features');
  });

  test('the empty and unread cases do not produce the same line', () => {
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

import { CLIENT_RUNTIME_VERSION_FALLBACK } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  classifyServerVersion,
  computeFirstLaunchAfterUpgrade,
  type DesktopVersion,
} from './version-drift.ts';

const SELF: DesktopVersion = { protocolVersion: 1, runtimeVersion: '0.8.2' };

describe('classifyServerVersion', () => {
  test('same protocol + same runtime → same', () => {
    expect(classifyServerVersion({ protocolVersion: 1, runtimeVersion: '0.8.2' }, SELF)).toEqual({
      relation: 'same',
      dimension: null,
    });
  });

  test('older runtime, same protocol → older by runtime', () => {
    expect(classifyServerVersion({ protocolVersion: 1, runtimeVersion: '0.8.0' }, SELF)).toEqual({
      relation: 'older',
      dimension: 'runtime',
    });
  });

  test('newer runtime → newer by runtime', () => {
    expect(classifyServerVersion({ protocolVersion: 1, runtimeVersion: '0.9.0' }, SELF)).toEqual({
      relation: 'newer',
      dimension: 'runtime',
    });
  });

  test('prerelease ranks below its release: beta < stable → older', () => {
    expect(
      classifyServerVersion({ protocolVersion: 1, runtimeVersion: '0.8.2-beta.3' }, SELF),
    ).toEqual({ relation: 'older', dimension: 'runtime' });
  });

  test('prerelease ordering: server beta.4 vs self beta.2 → newer', () => {
    expect(
      classifyServerVersion(
        { protocolVersion: 1, runtimeVersion: '0.8.2-beta.4' },
        { protocolVersion: 1, runtimeVersion: '0.8.2-beta.2' },
      ),
    ).toEqual({ relation: 'newer', dimension: 'runtime' });
  });

  test('protocol mismatch dominates: older protocol + newer runtime → older by protocol', () => {
    expect(classifyServerVersion({ protocolVersion: 0, runtimeVersion: '9.9.9' }, SELF)).toEqual({
      relation: 'older',
      dimension: 'protocol',
    });
  });

  test('newer protocol → newer by protocol', () => {
    expect(classifyServerVersion({ protocolVersion: 2, runtimeVersion: '0.8.2' }, SELF)).toEqual({
      relation: 'newer',
      dimension: 'protocol',
    });
  });

  test('missing protocolVersion (legacy lock) → indeterminate', () => {
    expect(classifyServerVersion({ runtimeVersion: '0.8.0' }, SELF)).toEqual({
      relation: 'indeterminate',
      dimension: null,
    });
  });

  test('missing runtimeVersion (legacy lock) → indeterminate', () => {
    expect(classifyServerVersion({ protocolVersion: 1 }, SELF)).toEqual({
      relation: 'indeterminate',
      dimension: null,
    });
  });

  test('server runtime is the unknown sentinel → indeterminate (NOT older)', () => {
    expect(
      classifyServerVersion(
        { protocolVersion: 1, runtimeVersion: CLIENT_RUNTIME_VERSION_FALLBACK },
        SELF,
      ),
    ).toEqual({ relation: 'indeterminate', dimension: null });
  });

  test('self runtime is the unknown sentinel → indeterminate', () => {
    expect(
      classifyServerVersion(
        { protocolVersion: 1, runtimeVersion: '0.8.2' },
        { protocolVersion: 1, runtimeVersion: CLIENT_RUNTIME_VERSION_FALLBACK },
      ),
    ).toEqual({ relation: 'indeterminate', dimension: null });
  });

  test('non-semver runtime string → indeterminate', () => {
    expect(classifyServerVersion({ protocolVersion: 1, runtimeVersion: 'garbage' }, SELF)).toEqual({
      relation: 'indeterminate',
      dimension: null,
    });
  });

  test('protocol mismatch is classified even when server runtime is the sentinel', () => {
    expect(
      classifyServerVersion(
        { protocolVersion: 0, runtimeVersion: CLIENT_RUNTIME_VERSION_FALLBACK },
        SELF,
      ),
    ).toEqual({ relation: 'older', dimension: 'protocol' });
  });
});

describe('computeFirstLaunchAfterUpgrade', () => {
  test('fresh install (lastSeenVersion === null) → false, not an upgrade', () => {
    expect(computeFirstLaunchAfterUpgrade(null, '0.8.2')).toBe(false);
  });

  test('same version as last launch → false', () => {
    expect(computeFirstLaunchAfterUpgrade('0.8.2', '0.8.2')).toBe(false);
  });

  test('version changed since last launch → true (upgrade)', () => {
    expect(computeFirstLaunchAfterUpgrade('0.8.1', '0.8.2')).toBe(true);
  });

  test('version changed downward (rollback) also counts → true', () => {
    expect(computeFirstLaunchAfterUpgrade('0.9.0', '0.8.2')).toBe(true);
  });
});

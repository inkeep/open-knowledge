import { describe, expect, test } from 'vitest';
import {
  type AutoSyncOnboardingGateInputs,
  resolveAutoSyncOnboarding,
} from './auto-sync-onboarding-gate.ts';

// Baseline = every condition aligned so the modal SHOWS the full-sync variant
// (probe allowed). Each test flips one input and asserts the gate's response,
// keeping every condition on its own independently verifiable row.
const SHOWING: AutoSyncOnboardingGateInputs = {
  autoSyncOnboardingDismissed: false,
  hasRemote: true,
  projectLocalSynced: true,
  projectSynced: true,
  projectLocalConfig: { autoSync: { mode: null, enabled: null } },
  projectConfig: { autoSync: { default: null } },
  pushPermissionCheckStatus: 'allowed',
};

describe('resolveAutoSyncOnboarding', () => {
  test('shows the full-sync variant when aligned and the probe allows pushing', () => {
    expect(resolveAutoSyncOnboarding(SHOWING)).toBe('full');
  });

  test('hidden once dismissed this session', () => {
    expect(resolveAutoSyncOnboarding({ ...SHOWING, autoSyncOnboardingDismissed: true })).toBeNull();
  });

  test('hidden without a git remote', () => {
    expect(resolveAutoSyncOnboarding({ ...SHOWING, hasRemote: false })).toBeNull();
    expect(resolveAutoSyncOnboarding({ ...SHOWING, hasRemote: undefined })).toBeNull();
  });

  test('hidden until the project-local binding has synced (flash-free)', () => {
    expect(resolveAutoSyncOnboarding({ ...SHOWING, projectLocalSynced: false })).toBeNull();
    expect(resolveAutoSyncOnboarding({ ...SHOWING, projectLocalSynced: undefined })).toBeNull();
  });

  test('hidden until the committed project binding has synced (flash-free)', () => {
    // Without the projectSynced guard, a project shipping a committed default
    // would briefly read the schema default (null) and flash the modal open.
    expect(resolveAutoSyncOnboarding({ ...SHOWING, projectSynced: false })).toBeNull();
    expect(resolveAutoSyncOnboarding({ ...SHOWING, projectSynced: undefined })).toBeNull();
  });

  test('hidden until project-local config hydrates', () => {
    expect(resolveAutoSyncOnboarding({ ...SHOWING, projectLocalConfig: null })).toBeNull();
  });

  test('hidden once this machine has answered via mode (off/pull/full)', () => {
    for (const mode of ['off', 'follow', 'full'] as const) {
      expect(
        resolveAutoSyncOnboarding({
          ...SHOWING,
          projectLocalConfig: { autoSync: { mode } },
        }),
      ).toBeNull();
    }
  });

  test('hidden once this machine has answered via the legacy enabled boolean', () => {
    expect(
      resolveAutoSyncOnboarding({
        ...SHOWING,
        projectLocalConfig: { autoSync: { enabled: true } },
      }),
    ).toBeNull();
    expect(
      resolveAutoSyncOnboarding({
        ...SHOWING,
        projectLocalConfig: { autoSync: { enabled: false } },
      }),
    ).toBeNull();
  });

  test('suppressed when the maintainer committed a mode-valued default', () => {
    for (const def of ['off', 'follow', 'full'] as const) {
      expect(
        resolveAutoSyncOnboarding({
          ...SHOWING,
          projectConfig: { autoSync: { default: def } },
        }),
      ).toBeNull();
    }
  });

  test('suppressed when the maintainer committed a legacy boolean default', () => {
    expect(
      resolveAutoSyncOnboarding({
        ...SHOWING,
        projectConfig: { autoSync: { default: false } },
      }),
    ).toBeNull();
    expect(
      resolveAutoSyncOnboarding({
        ...SHOWING,
        projectConfig: { autoSync: { default: true } },
      }),
    ).toBeNull();
  });

  test('still asks when committed config is absent or default is null/absent', () => {
    expect(resolveAutoSyncOnboarding({ ...SHOWING, projectConfig: null })).toBe('full');
    expect(resolveAutoSyncOnboarding({ ...SHOWING, projectConfig: { autoSync: {} } })).toBe('full');
    expect(resolveAutoSyncOnboarding({ ...SHOWING, projectConfig: {} })).toBe('full');
  });

  test('forks to the follow variant when the push probe is denied', () => {
    expect(resolveAutoSyncOnboarding({ ...SHOWING, pushPermissionCheckStatus: 'denied' })).toBe(
      'follow',
    );
  });

  test('suppressed while the push probe is unknown or still pending', () => {
    expect(
      resolveAutoSyncOnboarding({ ...SHOWING, pushPermissionCheckStatus: 'unknown' }),
    ).toBeNull();
    expect(
      resolveAutoSyncOnboarding({ ...SHOWING, pushPermissionCheckStatus: undefined }),
    ).toBeNull();
  });
});

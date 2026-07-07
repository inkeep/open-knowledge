import { describe, expect, test } from 'bun:test';
import {
  type AutoSyncOnboardingGateInputs,
  shouldShowAutoSyncOnboarding,
} from './auto-sync-onboarding-gate.ts';

// Baseline = every condition aligned so the modal SHOWS. Each test flips one
// input and asserts the gate's response, keeping every condition on its own
// independently verifiable row.
const SHOWING: AutoSyncOnboardingGateInputs = {
  autoSyncOnboardingDismissed: false,
  hasRemote: true,
  projectLocalSynced: true,
  projectSynced: true,
  projectLocalConfig: { autoSync: { enabled: null } },
  projectConfig: { autoSync: { default: null } },
  pushPermissionCheckStatus: 'allowed',
};

describe('shouldShowAutoSyncOnboarding', () => {
  test('shows when every condition is aligned (unanswered machine, no committed default)', () => {
    expect(shouldShowAutoSyncOnboarding(SHOWING)).toBe(true);
  });

  test('hidden once dismissed this session', () => {
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, autoSyncOnboardingDismissed: true })).toBe(
      false,
    );
  });

  test('hidden without a git remote', () => {
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, hasRemote: false })).toBe(false);
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, hasRemote: undefined })).toBe(false);
  });

  test('hidden until the project-local binding has synced (flash-free)', () => {
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, projectLocalSynced: false })).toBe(false);
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, projectLocalSynced: undefined })).toBe(false);
  });

  test('hidden until the committed project binding has synced (flash-free)', () => {
    // Without the projectSynced guard, a project shipping default:false would
    // briefly read the schema default (null) and flash the modal open.
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, projectSynced: false })).toBe(false);
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, projectSynced: undefined })).toBe(false);
  });

  test('hidden until project-local config hydrates', () => {
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, projectLocalConfig: null })).toBe(false);
  });

  test('hidden once this machine has answered (enabled true or false)', () => {
    expect(
      shouldShowAutoSyncOnboarding({
        ...SHOWING,
        projectLocalConfig: { autoSync: { enabled: true } },
      }),
    ).toBe(false);
    expect(
      shouldShowAutoSyncOnboarding({
        ...SHOWING,
        projectLocalConfig: { autoSync: { enabled: false } },
      }),
    ).toBe(false);
  });

  test('suppressed when the maintainer committed autoSync.default: false', () => {
    expect(
      shouldShowAutoSyncOnboarding({
        ...SHOWING,
        projectConfig: { autoSync: { default: false } },
      }),
    ).toBe(false);
  });

  test('suppressed when the maintainer committed autoSync.default: true', () => {
    expect(
      shouldShowAutoSyncOnboarding({
        ...SHOWING,
        projectConfig: { autoSync: { default: true } },
      }),
    ).toBe(false);
  });

  test('still asks when committed config is absent or default is null/absent', () => {
    // projectConfig === null (committed doc empty) → no seed → ask.
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, projectConfig: null })).toBe(true);
    // autoSync present but default absent → no seed → ask.
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, projectConfig: { autoSync: {} } })).toBe(
      true,
    );
    // autoSync absent entirely → no seed → ask.
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, projectConfig: {} })).toBe(true);
  });

  test('hidden when the push-permission probe denied or is still pending', () => {
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, pushPermissionCheckStatus: 'denied' })).toBe(
      false,
    );
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, pushPermissionCheckStatus: undefined })).toBe(
      false,
    );
  });

  test('shows on probe unknown (graceful degradation)', () => {
    expect(shouldShowAutoSyncOnboarding({ ...SHOWING, pushPermissionCheckStatus: 'unknown' })).toBe(
      true,
    );
  });
});

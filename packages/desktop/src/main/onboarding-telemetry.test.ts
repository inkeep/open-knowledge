/**
 * Onboarding-telemetry — assert the span emitter wraps `withSpanSync` with
 * the canonical span name and attribute shape, and that the `warnings_count`
 * cap+floor clamp is correctly applied. `withSpanSync` is mocked at the
 * module boundary so the assertions are independent of whether the OTel SDK
 * is enabled.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { EntryPoint } from '../shared/entry-point.ts';

interface CapturedSpanCall {
  name: string;
  options: { attributes?: Record<string, unknown> } | undefined;
}

const capturedCalls: CapturedSpanCall[] = [];

mock.module('@inkeep/open-knowledge-server', () => ({
  withSpanSync: <T>(
    name: string,
    options: { attributes?: Record<string, unknown> } | undefined,
    fn: () => T,
  ): T => {
    capturedCalls.push({ name, options });
    return fn();
  },
}));

const telemetryModule = await import('./onboarding-telemetry.ts');
const { recordOnboardingFlow } = telemetryModule;

type Attrs = Record<string, unknown>;

const expectAttrs = (call: CapturedSpanCall, expected: Attrs): void => {
  expect(call.name).toBe('ok.desktop.onboardingConsent');
  expect(call.options?.attributes).toEqual(expected);
};

describe('recordOnboardingFlow — span name + attribute shape', () => {
  beforeEach(() => {
    capturedCalls.length = 0;
  });

  test('emits a span named `ok.desktop.onboardingConsent` with the canonical attribute set', () => {
    recordOnboardingFlow({
      flowKind: 'create-new-default',
      entryPoint: 'create-new',
      gitInitRequested: true,
      contentDirChanged: false,
      warningsCount: 0,
    });
    expect(capturedCalls).toHaveLength(1);
    expectAttrs(capturedCalls[0], {
      'ok.desktop.flow_kind': 'create-new-default',
      'ok.desktop.entry_point': 'create-new',
      'ok.desktop.git_init_requested': true,
      'ok.desktop.content_dir_changed': false,
      'ok.desktop.warnings_count': 0,
      'ok.desktop.ai_integrations_failed_count': 0,
    });
  });

  test('failedCount lands as ok.desktop.ai_integrations_failed_count', () => {
    recordOnboardingFlow({
      flowKind: 'fresh-customized',
      entryPoint: 'pick-existing',
      gitInitRequested: false,
      contentDirChanged: false,
      warningsCount: 0,
      failedCount: 3,
    });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].options?.attributes?.['ok.desktop.ai_integrations_failed_count']).toBe(
      3,
    );
  });

  test('failedCount clamps to FAILED_COUNT_CAP (10) on inputs above the cap', () => {
    recordOnboardingFlow({
      flowKind: 'fresh-customized',
      entryPoint: 'pick-existing',
      gitInitRequested: false,
      contentDirChanged: false,
      warningsCount: 0,
      failedCount: 999,
    });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].options?.attributes?.['ok.desktop.ai_integrations_failed_count']).toBe(
      10,
    );
  });

  test('failedCount clamps to 0 on negative inputs', () => {
    recordOnboardingFlow({
      flowKind: 'cancel',
      entryPoint: 'recents',
      gitInitRequested: false,
      contentDirChanged: false,
      warningsCount: 0,
      failedCount: -2,
    });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].options?.attributes?.['ok.desktop.ai_integrations_failed_count']).toBe(
      0,
    );
  });

  test('absent failedCount defaults to 0 (back-compat with cancel/managed paths)', () => {
    recordOnboardingFlow({
      flowKind: 'managed-direct',
      entryPoint: 'recents',
      gitInitRequested: false,
      contentDirChanged: false,
      warningsCount: 0,
    });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].options?.attributes?.['ok.desktop.ai_integrations_failed_count']).toBe(
      0,
    );
  });

  test('warnings_count clamps to the cap (8) on inputs above 8', () => {
    recordOnboardingFlow({
      flowKind: 'fresh-default',
      entryPoint: 'pick-existing',
      gitInitRequested: true,
      contentDirChanged: false,
      warningsCount: 100,
    });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].options?.attributes?.['ok.desktop.warnings_count']).toBe(8);
  });

  test('warnings_count clamps to 0 on negative inputs', () => {
    recordOnboardingFlow({
      flowKind: 'cancel',
      entryPoint: 'recents',
      gitInitRequested: false,
      contentDirChanged: false,
      warningsCount: -5,
    });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].options?.attributes?.['ok.desktop.warnings_count']).toBe(0);
  });

  test('warnings_count truncates fractional inputs before clamping', () => {
    recordOnboardingFlow({
      flowKind: 'managed-direct',
      entryPoint: 'recents',
      gitInitRequested: false,
      contentDirChanged: false,
      warningsCount: 3.9,
    });
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].options?.attributes?.['ok.desktop.warnings_count']).toBe(3);
  });

  const FLOW_KINDS = [
    'managed-promote',
    'managed-promote-cancelled',
    'managed-direct',
    'fresh-default',
    'fresh-customized',
    'create-new-default',
    'create-new-customized',
    'cancel',
  ] as const;

  for (const kind of FLOW_KINDS) {
    test(`flowKind="${kind}" lands as ok.desktop.flow_kind`, () => {
      recordOnboardingFlow({
        flowKind: kind,
        entryPoint: 'pick-existing',
        gitInitRequested: false,
        contentDirChanged: false,
        warningsCount: 0,
      });
      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].options?.attributes?.['ok.desktop.flow_kind']).toBe(kind);
    });
  }

  const ENTRY_POINTS: readonly EntryPoint[] = [
    'create-new',
    'create-new-nested-redirect',
    'pick-existing',
    'recents',
    'deep-link',
    'drag-drop',
  ] as const;

  for (const entry of ENTRY_POINTS) {
    test(`entryPoint="${entry}" lands as ok.desktop.entry_point`, () => {
      recordOnboardingFlow({
        flowKind: 'managed-direct',
        entryPoint: entry,
        gitInitRequested: false,
        contentDirChanged: false,
        warningsCount: 0,
      });
      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].options?.attributes?.['ok.desktop.entry_point']).toBe(entry);
    });
  }
});

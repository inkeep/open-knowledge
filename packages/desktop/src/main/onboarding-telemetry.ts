/**
 * `ok.desktop.onboardingConsent` span emitter.
 *
 * Wraps `withSpanSync` from the server's telemetry helpers so the desktop's
 * onboarding flows emit one span per pick with bounded-cardinality
 * attributes — never raw paths, never user-input strings (cardinality STOP
 * rule). When the SDK is disabled (default builds), `withSpanSync` is a
 * no-op so this path adds zero overhead.
 */

import type { CreateNewBannerKind } from '@inkeep/open-knowledge-core';
import { withSpanSync } from '@inkeep/open-knowledge-server';
import type { EntryPoint } from '../shared/entry-point.ts';
import type { HandoffOutcome } from './share-handoff.ts';

export type OnboardingFlowKind =
  | 'managed-promote'
  | 'managed-promote-cancelled'
  | 'managed-direct'
  | 'fresh-default'
  | 'fresh-customized'
  | 'create-new-default'
  | 'create-new-customized'
  | 'cancel';

interface OnboardingTelemetryAttributes {
  flowKind: OnboardingFlowKind;
  entryPoint: EntryPoint;
  gitInitRequested: boolean;
  contentDirChanged: boolean;
  warningsCount: number;
  /** Count of `writeProjectAiIntegrations` per-(editor × integration)
   *  `action === 'failed'` results from this flow (silent or dialog path).
   *  Defaults to 0 when the helper didn't run (cancel) or had no failures. */
  failedCount?: number;
}

/** Cap on the warnings_count attribute — cardinality discipline. */
const WARNINGS_COUNT_CAP = 8;
/** Cap on failed_count. Six editor IDs today; leave headroom while keeping
 *  the bucket count tight. */
const FAILED_COUNT_CAP = 10;

/**
 * Discrete fire-and-forget banner-shown event for the Create-new-project
 * dialog cascade. Fired by the renderer through
 * `bridge.project.recordCreateNewBannerShown` on first banner appearance
 * per dialog open (renderer dedupes; main does not). Bounded-cardinality:
 * `banner` is a closed literal union.
 */
export function recordCreateNewBannerShown(banner: CreateNewBannerKind): void {
  withSpanSync(
    'ok.desktop.createNewBannerShown',
    {
      attributes: {
        'ok.desktop.banner': banner,
      },
    },
    () => undefined,
  );
}

/** Outcome of the first-run deferred-share handshake — re-exported from the handshake module. */
export type FirstRunHandoffOutcome = HandoffOutcome;

/**
 * Emit one `ok.desktop.firstRunShareHandoff` span recording the outcome of the
 * deferred-share first-run handshake. Bounded-cardinality: `outcome` is a
 * closed literal union; no share payload, URL, or token is ever attached. SDK
 * disabled → no-op.
 */
export function recordFirstRunShareHandoff(outcome: FirstRunHandoffOutcome): void {
  withSpanSync(
    'ok.desktop.firstRunShareHandoff',
    {
      attributes: {
        'ok.desktop.handoff_outcome': outcome,
      },
    },
    () => undefined,
  );
}

/**
 * Emit one `ok.desktop.onboardingConsent` span. The span is opened and
 * closed inside this call — no async work happens inside the body, so the
 * sync variant is sufficient. SDK disabled → no-op.
 */
export function recordOnboardingFlow(attrs: OnboardingTelemetryAttributes): void {
  withSpanSync(
    'ok.desktop.onboardingConsent',
    {
      attributes: {
        'ok.desktop.flow_kind': attrs.flowKind,
        'ok.desktop.entry_point': attrs.entryPoint,
        'ok.desktop.git_init_requested': attrs.gitInitRequested,
        'ok.desktop.content_dir_changed': attrs.contentDirChanged,
        'ok.desktop.warnings_count': Math.min(
          Math.max(0, Math.trunc(attrs.warningsCount)),
          WARNINGS_COUNT_CAP,
        ),
        'ok.desktop.ai_integrations_failed_count': Math.min(
          Math.max(0, Math.trunc(attrs.failedCount ?? 0)),
          FAILED_COUNT_CAP,
        ),
      },
    },
    () => undefined,
  );
}

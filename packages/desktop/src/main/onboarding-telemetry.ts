
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

const WARNINGS_COUNT_CAP = 8;
/** Cap on failed_count. Six editor IDs today; leave headroom while keeping
 *  the bucket count tight. */
const FAILED_COUNT_CAP = 10;

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

export type FirstRunHandoffOutcome = HandoffOutcome;

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

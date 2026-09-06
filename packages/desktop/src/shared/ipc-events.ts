import type { OkBugReportCrashDetectedEvent } from '@inkeep/open-knowledge-core';
import type { OkNoteWindowMainAction } from '@inkeep/open-knowledge-core/desktop-bridge';
import type {
  OkDesktopConfig,
  OkLocalOpAuthEvent,
  OkLocalOpCloneEvent,
  OkMenuActionDispatch,
  OkPtyData,
  OkPtyExit,
  OkPtyNotice,
  OkRecentRemovedMissingInfo,
  OkServerRestartedInfo,
  OkServerVersionDriftInfo,
  OkShareReceivedPayload,
} from './bridge-contract.ts';
import type {
  McpWiringEditorDetection,
  McpWiringGlobalSkillDescriptor,
  McpWiringPathInstallDescriptor,
  OnboardingShowPayload,
} from './ipc-channels.ts';

export interface EventChannels {
  'ok:project:switching': { payload: { projectPath: string } };
  'ok:project:switched': { payload: OkDesktopConfig };
  'ok:project:recent-removed-missing': { payload: OkRecentRemovedMissingInfo };
  'ok:menu-action': { payload: OkMenuActionDispatch };
  'ok:note-window:main-action': { payload: OkNoteWindowMainAction };
  'ok:update:downloaded': { payload: { version: string } };
  'ok:update:relaunching': { payload: { version: string } };
  'ok:update:fetching-latest': { payload: { version: string } };
  'ok:update:relaunch-failed': {
    payload: {
      version: string;
      message?: string;
      downloadUrl?: string;
      dismissPending?: boolean;
    };
  };
  'ok:update:whats-new': { payload: { version: string; releaseUrl: string } };
  'ok:update:whats-new-dismissed': { payload: { version: string } };
  'ok:update:stuck-hint': { payload: { downloadUrl: string } };
  'ok:update:manual-check': { payload: { phase: 'started' | 'settled' } };
  'ok:deep-link': {
    payload: {
      doc: string;
      kind: 'doc' | 'folder';
      branch?: string | null;
      multiCandidate?: boolean;
      targetMissing?: boolean;
      repositoryPath?: string;
      contentRootDepth?: number;
    };
  };
  'ok:share:received': { payload: OkShareReceivedPayload };
  'ok:mcp-wiring:show': {
    payload: {
      origin: 'first-run' | 'reconfigure';
      detectedEditors: readonly McpWiringEditorDetection[];
      pathInstall: McpWiringPathInstallDescriptor;
      globalSkills: readonly McpWiringGlobalSkillDescriptor[];
    };
  };
  'ok:onboarding:show': {
    payload: OnboardingShowPayload;
  };
  'ok:onboarding:toast': {
    payload:
      | { readonly kind: 'ancestor-promote'; readonly ancestorPath: string }
      | {
          readonly kind: 'git-root-promote';
          readonly gitRoot: string;
          readonly pickedPath: string;
        }
      | {
          readonly kind: 'startup-reclaim';
          readonly mcp:
            | { readonly status: 'none' }
            | { readonly status: 'repaired'; readonly editors: readonly string[] }
            | { readonly status: 'failed'; readonly editors: readonly string[] };
          readonly path:
            | { readonly status: 'none' }
            | { readonly status: 'installed'; readonly summary: string }
            | { readonly status: 'failed'; readonly summary: string };
        }
      | {
          readonly kind: 'sharing-refused-tracked';
          readonly tracked: readonly string[];
          readonly remediation: string;
        }
      | {
          readonly kind: 'sharing-no-git';
          readonly requestedMode: 'local-only';
        };
  };

  'ok:local-op:auth:event': {
    payload: { streamId: string; event: OkLocalOpAuthEvent };
  };
  'ok:local-op:clone:event': {
    payload: { streamId: string; event: OkLocalOpCloneEvent };
  };

  'ok:sidebar:expand-all': { payload: undefined };
  'ok:sidebar:collapse-all': { payload: undefined };

  'ok:server-version-drift': { payload: OkServerVersionDriftInfo };
  'ok:server-restarted': { payload: OkServerRestartedInfo };

  'ok:pty:data': { payload: OkPtyData };
  'ok:pty:exit': { payload: OkPtyExit };
  'ok:pty:notice': { payload: OkPtyNotice };
  'ok:accessibility:changed': { payload: { screenReaderActive: boolean } };
  'ok:bug-report:crash-detected': { payload: OkBugReportCrashDetectedEvent };
}

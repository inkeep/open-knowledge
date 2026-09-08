import type { OkBugReportCrashDetectedEvent } from '@inkeep/open-knowledge-core';
import type {
  OkDeepLinkPayload,
  OkNoteWindowMainAction,
  OkOnboardingToastPayload,
} from '@inkeep/open-knowledge-core/desktop-bridge';
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
  'ok:deep-link': { payload: OkDeepLinkPayload };
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
    payload: OkOnboardingToastPayload;
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

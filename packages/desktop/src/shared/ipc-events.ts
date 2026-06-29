import type {
  OkDesktopConfig,
  OkLocalOpAuthEvent,
  OkLocalOpCloneEvent,
  OkMenuAction,
  OkPtyData,
  OkPtyExit,
  OkServerReclaimedInfo,
  OkServerRestartedInfo,
  OkServerVersionDriftInfo,
  OkShareReceivedPayload,
} from './bridge-contract.ts';
import type { McpWiringEditorDetection, OnboardingShowPayload } from './ipc-channels.ts';

export interface EventChannels {
  'ok:project:switching': { payload: { projectPath: string } };
  'ok:project:switched': { payload: OkDesktopConfig };
  'ok:menu-action': { payload: OkMenuAction };
  'ok:update:downloaded': { payload: { version: string } };
  'ok:update:relaunching': { payload: { version: string } };
  'ok:update:relaunch-failed': {
    payload: { version: string; message?: string; downloadUrl?: string };
  };
  'ok:update:whats-new': { payload: { version: string; releaseUrl: string } };
  'ok:update:whats-new-dismissed': { payload: { version: string } };
  'ok:update:stuck-hint': { payload: { downloadUrl: string } };
  'ok:deep-link': {
    payload: {
      doc: string;
      kind: 'doc' | 'folder';
      branch?: string | null;
      multiCandidate?: boolean;
      targetMissing?: boolean;
    };
  };
  'ok:share:received': { payload: OkShareReceivedPayload };
  'ok:mcp-wiring:show': {
    payload: { detectedEditors: readonly McpWiringEditorDetection[] };
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
          /** The sub-folder the user originally picked; surfaces in the
           * toast so the user can see what got promoted to what. */
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
          /** Sharing-mode `local-only` refused at consent time because at
           *  least one OK artifact path is tracked upstream. Renderer
           *  shows a longer sonner notification (no auto-dismiss) so the
           *  user has time to read the remediation. */
          readonly kind: 'sharing-refused-tracked';
          readonly tracked: readonly string[];
          readonly remediation: string;
        }
      | {
          /** User picked `local-only` but the picked folder has no git
           *  repo (and `initGit` was off). Brief advisory toast. */
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
  'ok:server-reclaimed': { payload: OkServerReclaimedInfo };

  'ok:pty:data': { payload: OkPtyData };
  'ok:pty:exit': { payload: OkPtyExit };
}

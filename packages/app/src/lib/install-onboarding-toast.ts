import { EDITOR_LABELS } from '@inkeep/open-knowledge-core';
import { plural, t } from '@lingui/core/macro';
import { toast as sonnerToast } from 'sonner';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { relativeToProject } from '@/lib/project-paths';

const TOAST_DURATION_MS = 4000;
const STICKY_TOAST_DURATION_MS = 24 * 60 * 60 * 1000;

export function installOnboardingToastListener(opts: {
  bridge: OkDesktopBridge | undefined;
}): (() => void) | undefined {
  const bridge = opts.bridge;
  if (!bridge) return undefined;
  if (!bridge.onboarding) return undefined;
  return bridge.onboarding.onToast((payload) => {
    if (payload.kind === 'ancestor-promote') {
      const ancestorPath = payload.ancestorPath;
      sonnerToast.success(t`Opened existing OpenKnowledge project at ${ancestorPath}`, {
        duration: TOAST_DURATION_MS,
      });
      return;
    }
    if (payload.kind === 'startup-reclaim') {
      const parts: string[] = [];
      if (payload.mcp.status === 'repaired') {
        const names = payload.mcp.editors
          .map((id) => EDITOR_LABELS[id as keyof typeof EDITOR_LABELS] ?? id)
          .join(', ');
        parts.push(t`repaired ${names} MCP integration`);
      } else if (payload.mcp.status === 'failed') {
        parts.push(t`MCP auto-repair failed`);
      }
      if (payload.path.status === 'installed') parts.push(payload.path.summary);
      if (payload.path.status === 'failed') {
        const summary = payload.path.summary;
        parts.push(t`PATH install failed: ${summary}`);
      }
      const message = parts.length > 0 ? parts.join('; ') : t`OpenKnowledge integrations checked.`;
      const hasFailure = payload.mcp.status === 'failed' || payload.path.status === 'failed';
      const pathTouched = payload.path.status !== 'none';
      sonnerToast[hasFailure ? 'error' : 'success'](message, {
        duration: hasFailure || pathTouched ? STICKY_TOAST_DURATION_MS : TOAST_DURATION_MS,
        position: 'bottom-left',
      });
      return;
    }
    if (payload.kind === 'sharing-refused-tracked') {
      const trackedCount = payload.tracked.length;
      sonnerToast.error(
        t`Config sharing unchanged: ${plural(trackedCount, {
          one: '# OK file',
          other: '# OK files',
        })} tracked upstream — see message below.`,
        {
          duration: STICKY_TOAST_DURATION_MS,
          description: payload.remediation,
        },
      );
      return;
    }
    if (payload.kind === 'sharing-no-git') {
      sonnerToast.warning(
        t`Local-only requested but no git repository was created. Switch later via Settings → Sync & sharing once the project is in a git repo.`,
        { duration: TOAST_DURATION_MS },
      );
      return;
    }
    const subPath = relativeToProject(payload.gitRoot, payload.pickedPath) ?? payload.pickedPath;
    const gitRoot = payload.gitRoot;
    sonnerToast.success(
      t`Initialized OpenKnowledge at ${gitRoot} — opened parent of ${subPath} because it contains a .git folder`,
      { duration: TOAST_DURATION_MS },
    );
  });
}

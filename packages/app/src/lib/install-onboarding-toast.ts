
import { EDITOR_LABELS } from '@inkeep/open-knowledge-core';
import { toast as sonnerToast } from 'sonner';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { relativeToProject } from '@/lib/project-paths';

const TOAST_DURATION_MS = 4000;
/** "Sticky" toast — large finite duration in lieu of `Infinity`. Used for
 *  failure outcomes that surface an action item the user must see, and for
 *  PATH/rc-file edit disclosures — the user must get a real chance to notice
 *  that OpenKnowledge touched their shell config (and how to undo it).
 *  24h is long enough to span typical user idle windows; the close button
 *  on the Toaster gives an immediate-dismiss escape hatch. */
const STICKY_TOAST_DURATION_MS = 24 * 60 * 60 * 1000;

export function installOnboardingToastListener(opts: {
  bridge: OkDesktopBridge | undefined;
}): (() => void) | undefined {
  const bridge = opts.bridge;
  if (!bridge) return undefined;
  if (!bridge.onboarding) return undefined;
  return bridge.onboarding.onToast((payload) => {
    if (payload.kind === 'ancestor-promote') {
      sonnerToast.success(`Opened existing OpenKnowledge project at ${payload.ancestorPath}`, {
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
        parts.push(`repaired ${names} MCP integration`);
      } else if (payload.mcp.status === 'failed') {
        parts.push('MCP auto-repair failed');
      }
      if (payload.path.status === 'installed') parts.push(payload.path.summary);
      if (payload.path.status === 'failed')
        parts.push(`PATH install failed: ${payload.path.summary}`);
      const message = parts.length > 0 ? parts.join('; ') : 'OpenKnowledge integrations checked.';
      const hasFailure = payload.mcp.status === 'failed' || payload.path.status === 'failed';
      const pathTouched = payload.path.status !== 'none';
      sonnerToast[hasFailure ? 'error' : 'success'](message, {
        duration: hasFailure || pathTouched ? STICKY_TOAST_DURATION_MS : TOAST_DURATION_MS,
      });
      return;
    }
    if (payload.kind === 'sharing-refused-tracked') {
      sonnerToast.error(
        `Config sharing unchanged: ${payload.tracked.length} OK file(s) tracked upstream — see message below.`,
        {
          duration: STICKY_TOAST_DURATION_MS,
          description: payload.remediation,
        },
      );
      return;
    }
    if (payload.kind === 'sharing-no-git') {
      sonnerToast.warning(
        'Local-only requested but no git repository was created. Switch later via Settings → Config sharing once the project is in a git repo.',
        { duration: TOAST_DURATION_MS },
      );
      return;
    }
    const subPath = relativeToProject(payload.gitRoot, payload.pickedPath) ?? payload.pickedPath;
    sonnerToast.success(
      `Initialized OpenKnowledge at ${payload.gitRoot} — opened parent of ${subPath} because it contains a .git folder`,
      { duration: TOAST_DURATION_MS },
    );
  });
}

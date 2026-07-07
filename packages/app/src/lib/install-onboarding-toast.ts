/**
 * Renderer-side onboarding-toast bridge subscriber.
 *
 * Listens for `ok:onboarding:toast` events on a freshly-spawned editor
 * window (ancestor-promote / git-root-promote) and renders via sonner —
 * 4 s auto-dismiss for routine notices, sticky for failures and PATH-edit
 * disclosures. Module-init pattern so a toast that fires before
 * React mounts isn't dropped — `bridge.onboarding.onToast` returns
 * immediately on subscribe; sonner tolerates being called before its
 * `<Toaster />` mounts (queued internally).
 *
 * Web / CLI distribution: `bridge` is undefined and `install` is a no-op.
 */

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
  // Tolerate bridges without an `onboarding` namespace — same defensiveness
  // as `consent-store.ts`. e2e fake bridges that pre-date the
  // onboarding namespace would otherwise throw at module-init and crash
  // the renderer mid-mount.
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
      // refusal — surface a sticky error toast with the full
      // remediation. The desktop user can't `git rm --cached` from the UI
      // (yet); the toast gives them the exact CLI commands.
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
    // Render the picked sub-path relative to gitRoot — pickedPath is realpath-
    // canonicalized in folder-admission so an absolute realistic monorepo path
    // wraps to 3-4 lines in sonner. Fall back to the absolute path if
    // relativeToProject returns null (defensive: gitRootPromoted invariant
    // already guarantees descendant, but realpath edge cases on symlinked
    // trees are worth surviving without losing the toast).
    const subPath = relativeToProject(payload.gitRoot, payload.pickedPath) ?? payload.pickedPath;
    sonnerToast.success(
      `Initialized OpenKnowledge at ${payload.gitRoot} — opened parent of ${subPath} because it contains a .git folder`,
      { duration: TOAST_DURATION_MS },
    );
  });
}

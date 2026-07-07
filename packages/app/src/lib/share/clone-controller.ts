/**
 * Shared `ShareReceiveCloneController` factory. Both shells (App / Navigator)
 * use this so the streamlined flow behaves identically across windows.
 *
 * Composes three transports:
 *   - `authQueryTransport.status()` for the pre-flight + post-sign-in checks
 *   - external sign-in trigger (parent opens AuthModal; this factory only
 *     awaits its completion)
 *   - `cloneTransport.start(...)` for the actual clone, with progress events
 *     piped into a sonner toast lifecycle
 *
 * The folder picker uses `bridge.dialog.openFolder()` (native dialog). The
 * target dir is `<picked-parent>/<repo>` — same convention as CloneDialog,
 * just without the dialog confirmation step.
 */

import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import type { ShareReceiveCloneController } from '@/components/ShareReceiveDialog';
import type { OkDesktopBridge, OkLocalOpAuthStatusResponse } from '@/lib/desktop-bridge-types';
import { formatReceiveLog } from '@/lib/share/receive-flow';
import type { AuthQueryTransport } from '@/lib/transports/auth-query-transport';
import type { CloneTransport } from '@/lib/transports/clone-transport';

export interface CloneControllerDeps {
  /** Bridge for the native folder picker. */
  bridge: OkDesktopBridge;
  /** Auth-status query — HTTP in the editor, IPC in Navigator. */
  authQueryTransport: AuthQueryTransport;
  /** Clone executor — HTTP in the editor, IPC in Navigator. */
  cloneTransport: CloneTransport;
  /**
   * Parent-provided sign-in trigger. The controller calls this when the
   * user clicks the "Connect GitHub" link in the share-receive dialog.
   * The implementation should:
   *   1. Open AuthModal (with the appropriate transport for the shell)
   *   2. Resolve with the new auth status after the modal completes
   *   3. Resolve with `null` if the user cancelled the modal
   */
  openSignIn(): Promise<OkLocalOpAuthStatusResponse | null>;
}

/**
 * Extract the repo name from a github clone URL — used to compute the target
 * dir under the picked parent folder. Defensive against URL variants:
 * `https://github.com/o/r.git` and `https://github.com/o/r` both yield `r`.
 * Falls back to the literal last segment if the URL doesn't match the
 * expected shape so a future schema doesn't silently produce an empty dir.
 */
function repoNameFromCloneUrl(url: string): string {
  const match = /\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return match ? match[1] : 'repo';
}

export function createCloneController(deps: CloneControllerDeps): ShareReceiveCloneController {
  return {
    async getAuthStatus() {
      return deps.authQueryTransport.status();
    },
    async startSignIn() {
      return deps.openSignIn();
    },
    async runClone({ url, branch }) {
      const parent = await deps.bridge.dialog.openFolder();
      if (!parent) return { kind: 'cancelled' };
      const repoName = repoNameFromCloneUrl(url);
      const targetDir = `${parent.replace(/\/$/, '')}/${repoName}`;

      // Use sonner's controlled toast lifecycle — we own the ID so we can
      // update the same toast from "loading" → "success"/"error" without
      // stacking. Progress events from the transport flow into the toast
      // description for visibility on long clones.
      const toastId = toast.loading(t`Cloning ${repoName}...`, {
        duration: Number.POSITIVE_INFINITY,
      });

      const requestedBranch = typeof branch === 'string' && branch.length > 0 ? branch : null;
      try {
        // start() is inside the try so a synchronous throw (e.g. an unregistered
        // IPC handler) still dismisses the infinite-duration progress toast via
        // the catch below, rather than leaking it on screen.
        const handle = deps.cloneTransport.start({
          url,
          dir: targetDir,
          branch: requestedBranch,
        });
        for await (const event of handle.events) {
          if (event.type === 'progress') {
            // Clone CLI emits `{phase, pct}`. Render as e.g. "Resolving
            // deltas — 42%" so the user sees concrete progress on long
            // clones rather than a static spinner.
            const phase = event.phase;
            const pct = Math.round(event.pct);
            toast.loading(t`Cloning ${repoName}...`, {
              id: toastId,
              description: t`${phase} — ${pct}%`,
              duration: Number.POSITIVE_INFINITY,
            });
            continue;
          }
          if (event.type === 'branch-fallback') {
            console.log(formatReceiveLog({ branch_action: 'fallback', branch: event.branch }));
            toast.info(t`Branch ${event.branch} no longer exists. Cloned to default branch.`, {
              duration: 8000,
            });
            continue;
          }
          if (event.type === 'complete') {
            toast.success(t`Cloned ${repoName}.`, { id: toastId, duration: 4000 });
            return { kind: 'ok', dir: event.dir };
          }
          if (event.type === 'error') {
            // The share-receive dialog now owns failure presentation (a
            // persistent error view listing likely causes — private repo, not
            // signed in, etc.), so dismiss the progress toast and hand the raw
            // git message back as `detail` rather than firing a transient toast
            // the user can't read before it disappears.
            toast.dismiss(toastId);
            return { kind: 'error', detail: event.message };
          }
        }
        // Stream ended without a terminal event — surface as a failure so the
        // dialog's error view renders rather than the user seeing a silent freeze.
        toast.dismiss(toastId);
        return { kind: 'error', detail: 'Clone ended unexpectedly.' };
      } catch (err) {
        // A throw here means the transport itself failed (synchronous start()
        // failure, or the async iterator threw) rather than emitting a typed
        // error event — a contract violation worth a diagnostic line.
        console.warn('[clone-controller] clone transport threw', err);
        const message = err instanceof Error ? err.message : 'Unknown error';
        toast.dismiss(toastId);
        return { kind: 'error', detail: message };
      }
    },
  };
}

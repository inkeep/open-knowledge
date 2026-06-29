import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import type { ShareReceiveCloneController } from '@/components/ShareReceiveDialog';
import type { OkDesktopBridge, OkLocalOpAuthStatusResponse } from '@/lib/desktop-bridge-types';
import { formatReceiveLog } from '@/lib/share/receive-flow';
import type { AuthQueryTransport } from '@/lib/transports/auth-query-transport';
import type { CloneTransport } from '@/lib/transports/clone-transport';

export interface CloneControllerDeps {
  bridge: OkDesktopBridge;
  authQueryTransport: AuthQueryTransport;
  cloneTransport: CloneTransport;
  openSignIn(): Promise<OkLocalOpAuthStatusResponse | null>;
}

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

      const toastId = toast.loading(t`Cloning ${repoName}...`, {
        duration: Number.POSITIVE_INFINITY,
      });

      const requestedBranch = typeof branch === 'string' && branch.length > 0 ? branch : null;
      try {
        const handle = deps.cloneTransport.start({
          url,
          dir: targetDir,
          branch: requestedBranch,
        });
        for await (const event of handle.events) {
          if (event.type === 'progress') {
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
            toast.dismiss(toastId);
            return { kind: 'error', detail: event.message };
          }
        }
        toast.dismiss(toastId);
        return { kind: 'error', detail: 'Clone ended unexpectedly.' };
      } catch (err) {
        console.warn('[clone-controller] clone transport threw', err);
        const message = err instanceof Error ? err.message : 'Unknown error';
        toast.dismiss(toastId);
        return { kind: 'error', detail: message };
      }
    },
  };
}

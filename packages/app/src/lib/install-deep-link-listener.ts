import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { encodeShareTargetForHash } from '@/lib/doc-hash';
import { missDialogStore } from '@/lib/share/miss-dialog-store';
import { pendingReceiveNavStore } from '@/lib/share/pending-receive-nav-store';

interface InstallDeepLinkListenerOptions {
  bridge: OkDesktopBridge | undefined;
  setHash?: (hash: string) => void;
  emitToast?: (message: string, opts: { description: string; duration: number }) => void;
}

export function deriveShareReceiveToast(
  evt: { doc: string; branch?: string | null; multiCandidate?: boolean },
  projectPath: string,
): { message: string; description: string } | null {
  if (evt.branch === undefined || evt.branch === null || evt.branch === '') return null;
  if (projectPath === '') return null;
  if (evt.multiCandidate !== true) return null;
  const branch = evt.branch;
  return {
    message: t`Opened on branch ${branch}`,
    description: projectPath,
  };
}

export function installDeepLinkListener(
  opts: InstallDeepLinkListenerOptions,
): (() => void) | undefined {
  const bridge = opts.bridge;
  if (!bridge) return undefined;

  const setHash =
    opts.setHash ??
    ((hash: string) => {
      window.location.hash = hash;
    });
  const emitToast =
    opts.emitToast ??
    ((message: string, toastOpts: { description: string; duration: number }) => {
      toast(message, toastOpts);
    });
  return bridge.onDeepLink((evt) => {
    const kind = evt.kind ?? 'doc';
    const nav = {
      kind,
      path: evt.doc,
      repositoryPath: evt.repositoryPath ?? evt.doc,
      ...(evt.contentRootDepth === undefined ? {} : { contentRootDepth: evt.contentRootDepth }),
      branch: evt.branch ?? null,
    };
    if (evt.targetMissing === true) {
      missDialogStore.arm(nav);
      return;
    }
    pendingReceiveNavStore.arm(nav);
    setHash(encodeShareTargetForHash(kind, evt.doc, kind === 'doc' ? evt.branch : undefined));
    const payload = deriveShareReceiveToast(evt, bridge.config.projectPath);
    if (payload !== null) {
      emitToast(payload.message, { description: payload.description, duration: 3000 });
    }
  });
}

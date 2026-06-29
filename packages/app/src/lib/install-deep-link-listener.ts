import { toast } from 'sonner';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { encodeShareTargetForHash } from '@/lib/doc-hash';

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
  return {
    message: `Opened on branch ${evt.branch}`,
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
    if (evt.targetMissing === true) {
      const label = kind === 'folder' ? 'folder' : 'file';
      const onBranch =
        evt.branch === undefined || evt.branch === null || evt.branch === ''
          ? ''
          : ` on branch ${evt.branch}`;
      emitToast(`This ${label} isn't in your local checkout${onBranch} yet`, {
        description: 'Pull the latest changes, then open the share link again.',
        duration: 5000,
      });
      return;
    }
    setHash(encodeShareTargetForHash(kind, evt.doc, kind === 'doc' ? evt.branch : undefined));
    const payload = deriveShareReceiveToast(evt, bridge.config.projectPath);
    if (payload !== null) {
      emitToast(payload.message, { description: payload.description, duration: 3000 });
    }
  });
}

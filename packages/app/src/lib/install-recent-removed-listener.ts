import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export function recentRemovedMissingMessage(projectName: string): string {
  return t`Removed "${projectName}" from recent projects. Its folder no longer exists.`;
}

export function installRecentRemovedListener(opts: {
  bridge: OkDesktopBridge | undefined;
}): (() => void) | undefined {
  const bridge = opts.bridge;
  if (!bridge) return undefined;
  return bridge.onRecentRemovedMissing(({ projectName }) => {
    toast(recentRemovedMissingMessage(projectName));
  });
}

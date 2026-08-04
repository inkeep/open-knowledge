import { pushHashWithoutNavigation } from '@/lib/doc-hash';
import { navigationForSidebarDragPayload, type SidebarDragPayload } from '@/lib/sidebar-drag';
import type { TabOpenDisposition } from './editor-panes';

export type SidebarOpenTarget = (
  target: ReturnType<typeof navigationForSidebarDragPayload>['target'],
  options: { disposition: TabOpenDisposition; consumeActiveNewTab: boolean },
) => void;

export function openSidebarDropPayload(
  payload: SidebarDragPayload,
  openTarget: SidebarOpenTarget,
  consumeActiveNewTab: boolean,
): void {
  const navigation = navigationForSidebarDragPayload(payload);
  openTarget(navigation.target, { disposition: 'permanent', consumeActiveNewTab });
  pushHashWithoutNavigation(navigation.hash);
}

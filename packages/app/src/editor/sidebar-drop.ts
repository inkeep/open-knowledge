import type { EditorOptions } from '@tiptap/core';
import { pushHashWithoutNavigation } from '@/lib/doc-hash';
import {
  navigationForSidebarDragPayload,
  parseSidebarDragPayload,
  type SidebarDragPayload,
} from '@/lib/sidebar-drag';

type EditorHandleDrop = NonNullable<NonNullable<EditorOptions['editorProps']>['handleDrop']>;
type EditorDropView = Parameters<EditorHandleDrop>[0];
export type SidebarOpenTarget = (
  target: ReturnType<typeof navigationForSidebarDragPayload>['target'],
  options: { tabBehavior: 'append' },
) => void;

export function createSidebarAwareHandleDrop(
  clipboardDrop: (view: EditorDropView, event: DragEvent) => boolean,
  onSidebarDrop?: (payload: SidebarDragPayload) => void,
): EditorHandleDrop {
  return (view, event) => {
    const dragEvent = event as DragEvent;
    const sidebarPayload = parseSidebarDragPayload(dragEvent.dataTransfer);
    if (sidebarPayload) {
      dragEvent.preventDefault();
      onSidebarDrop?.(sidebarPayload);
      return true;
    }
    return clipboardDrop(view, dragEvent);
  };
}

export function openSidebarDropPayload(
  payload: SidebarDragPayload,
  openTarget: SidebarOpenTarget,
): void {
  const navigation = navigationForSidebarDragPayload(payload);
  openTarget(navigation.target, { tabBehavior: 'append' });
  pushHashWithoutNavigation(navigation.hash);
}

import type { TabOpenDisposition } from '@/editor/editor-panes';

export function previewOpenDisposition(previewTabsEnabled: boolean): TabOpenDisposition {
  return previewTabsEnabled ? 'preview' : 'permanent';
}

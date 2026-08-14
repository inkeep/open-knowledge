import type { TabOpenDisposition } from '@/editor/editor-panes';

/**
 * The single rule for what disposition a preview-eligible open gets.
 *
 * Two surfaces need it and must not drift: the Files tree, which opens a target
 * and records a history entry for it, and the hash handler, which re-opens
 * that target when the entry is replayed by Back/Forward. If the two derived
 * the disposition independently, a replay could silently promote a
 * provisional open into a durable tab.
 */
export function previewOpenDisposition(previewTabsEnabled: boolean): TabOpenDisposition {
  return previewTabsEnabled ? 'preview' : 'permanent';
}

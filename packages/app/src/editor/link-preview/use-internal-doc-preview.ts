/**
 * Reader hook for the internal doc-preview card. Returns the preview data for a
 * resolved internal target: title / folder / modified-time land synchronously
 * from the page-list index; tags, excerpt, and backlink count fill in from the
 * local server and are each omitted (left undefined) on failure so the card
 * enhances progressively and degrades to the pill on error.
 *
 * Author attribution (edited-by identity) is intentionally not surfaced here —
 * only the local modified time is available without a heavier history read.
 */

import { useEffect, useState } from 'react';
import { usePageList } from '../../components/PageListContext';
import {
  deriveContentFields,
  deriveFolderPath,
  type InternalDocContentFields,
  type InternalDocPreview,
  loadBacklinkCount,
  loadDocContent,
} from './internal-doc-preview.ts';

interface UseInternalDocPreviewParams {
  /** Resolved document name, or null when the target is not a resolved doc. */
  docName: string | null;
  /** Optional heading anchor for a section-scoped excerpt. */
  anchor: string | null;
  /** When false, no reads run and the hook returns null (no card). */
  enabled: boolean;
}

export function useInternalDocPreview({
  docName,
  anchor,
  enabled,
}: UseInternalDocPreviewParams): InternalDocPreview | null {
  const { pageTitles, pageMeta } = usePageList();
  // The hover panel is a reused singleton, so `docName` can change without a
  // remount while the synchronous fields update in the same render. The async
  // fields are therefore stored WITH the target they were loaded for and
  // matched at render — the same binding as `useExternalLinkPreview` — so a
  // chip-to-chip focus move can never paint the previous doc's excerpt / tags /
  // backlinks under the new doc's title, not even for the one frame before a
  // reset effect would have run.
  const [contentEntry, setContentEntry] = useState<{
    docName: string;
    anchor: string | null;
    fields: InternalDocContentFields;
  } | null>(null);
  const [backlinkEntry, setBacklinkEntry] = useState<{
    docName: string;
    count: number;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !docName) return;

    let cancelled = false;
    void loadDocContent(docName).then((content) => {
      if (cancelled || content === null) return;
      setContentEntry({ docName, anchor, fields: deriveContentFields(content, anchor) });
    });
    void loadBacklinkCount(docName).then((count) => {
      if (cancelled || count === null) return;
      setBacklinkEntry({ docName, count });
    });
    return () => {
      cancelled = true;
    };
  }, [docName, anchor, enabled]);

  if (!enabled || !docName) return null;

  const contentFields =
    contentEntry !== null && contentEntry.docName === docName && contentEntry.anchor === anchor
      ? contentEntry.fields
      : null;
  const backlinkCount =
    backlinkEntry !== null && backlinkEntry.docName === docName ? backlinkEntry.count : null;

  return {
    docName,
    title: pageTitles.get(docName) ?? docName,
    folderPath: deriveFolderPath(docName),
    lastEditedAt: pageMeta.get(docName)?.modified ?? null,
    tags: contentFields?.tags,
    excerpt: contentFields?.excerpt,
    backlinkCount: backlinkCount ?? undefined,
  };
}

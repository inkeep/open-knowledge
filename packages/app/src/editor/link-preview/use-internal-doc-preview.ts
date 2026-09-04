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
  docName: string | null;
  anchor: string | null;
  enabled: boolean;
}

export function useInternalDocPreview({
  docName,
  anchor,
  enabled,
}: UseInternalDocPreviewParams): InternalDocPreview | null {
  const { pageTitles, pageMeta } = usePageList();
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

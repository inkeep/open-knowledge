import type { LinkPreviewMetadata } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { loadLinkPreview } from './external-link-preview.ts';

interface UseExternalLinkPreviewParams {
  url: string | null;
  enabled: boolean;
}

export function useExternalLinkPreview({
  url,
  enabled,
}: UseExternalLinkPreviewParams): LinkPreviewMetadata | null {
  const [entry, setEntry] = useState<{ url: string; metadata: LinkPreviewMetadata } | null>(null);

  useEffect(() => {
    if (!enabled || !url) return;

    const controller = new AbortController();
    void loadLinkPreview(url, controller.signal).then((result) => {
      if (controller.signal.aborted || !result) return;
      setEntry({ url, metadata: result });
    });
    return () => controller.abort();
  }, [url, enabled]);

  if (!enabled || !url) return null;
  return entry?.url === url ? entry.metadata : null;
}

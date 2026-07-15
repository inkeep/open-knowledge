/**
 * Reader hook for the external link-preview card. Returns the fetched metadata
 * for an external URL, or `null` while loading, on any failure, or when the
 * feature is disabled — so the card renders only on success and every other
 * state leaves today's URL pill (the zero-regression contract).
 *
 * The fetch runs from an effect keyed on the URL, so it fires only while the
 * hover panel is open on this link. The panel opens after the interaction
 * layer's sustained-dwell delay, which makes the fetch dwell-gated without any
 * change to the hover machine: a cursor merely transiting a link never opens the
 * panel, so no egress request is sent. Hover-out (or re-targeting to a different
 * link) unmounts/re-runs the effect, aborting the in-flight request.
 */

import type { LinkPreviewMetadata } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { loadLinkPreview } from './external-link-preview.ts';

interface UseExternalLinkPreviewParams {
  /** The external URL to preview, or null when the target is not an external link. */
  url: string | null;
  /** The `linkPreviews.enabled` egress gate. When false, no request is sent. */
  enabled: boolean;
}

export function useExternalLinkPreview({
  url,
  enabled,
}: UseExternalLinkPreviewParams): LinkPreviewMetadata | null {
  // Store the metadata together with the URL it belongs to. The hover panel is
  // a reused singleton, so `url` can change without a remount; binding the
  // result to its URL means a resolved card for the previous link never renders
  // under the new link's pill while the new fetch is still in flight.
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

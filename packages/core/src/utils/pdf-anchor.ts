export interface PdfAnchorParts {
  height: number | null;
  viewerFragment: string;
}

export function parsePdfAnchor(anchor: string | undefined | null): PdfAnchorParts {
  if (!anchor) return { height: null, viewerFragment: '' };
  const segments = anchor.split('&').filter((s) => s.length > 0);
  let height: number | null = null;
  const viewerSegments: string[] = [];
  for (const segment of segments) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx === -1) {
      viewerSegments.push(segment);
      continue;
    }
    const key = segment.slice(0, eqIdx);
    const value = segment.slice(eqIdx + 1);
    if (key === 'height') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed) && parsed > 0) height = parsed;
      continue;
    }
    viewerSegments.push(segment);
  }
  return { height, viewerFragment: viewerSegments.join('&') };
}

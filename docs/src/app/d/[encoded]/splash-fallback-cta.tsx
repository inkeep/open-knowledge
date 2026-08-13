'use client';

import { useEffect, useState } from 'react';
import {
  classifyDownloadOs,
  type DetectedOs,
  downloadHrefForDetectedOs,
  readPlatformInput,
} from '@/lib/download-targets';
import { SPLASH_INSTALL_COMMAND } from '@/lib/share-splash';
import { downloadRouteForCta } from '@/lib/site';
import { SplashDownloadSplitButton } from './splash-download-split-button';

/**
 * Tracked stable-download route, tagged so a download that starts from a
 * broken or outdated share link is attributable rather than anonymous. Already
 * carries a query, which is why the panel joins each build's params with `&`.
 */
const FALLBACK_DOWNLOAD_URL = downloadRouteForCta('share-splash-fallback');

/**
 * The download CTA for the two fallback screens, which reach this page with no
 * decoded share: the same segmented control the share splash uses, minus the
 * parts that need a repo.
 *
 * It is the split button rather than a plain link because these visitors are
 * no better at naming their own architecture than anyone else — the primary
 * segment sends Windows/Linux to the picker and the caret carries every
 * explicit build plus the npm path. There is no separate "Open with CLI"
 * button beside it: that button's panel could only offer a bare install with
 * no share to open, and
 * the npm route already sits one click away in this caret.
 *
 * Mirrors SplashCtaPanel's progressive enhancement — SSR renders the macOS
 * floor and hydration sends architecture-ambiguous platforms to the picker,
 * so the link works with scripting off without guessing for Windows/Linux.
 */
export function SplashFallbackCta() {
  const [os, setOs] = useState<DetectedOs>('unknown');

  useEffect(() => {
    setOs(classifyDownloadOs(readPlatformInput()));
  }, []);

  return (
    <SplashDownloadSplitButton
      downloadUrl={downloadHrefForDetectedOs('share-splash-fallback', os)}
      platformBaseUrl={FALLBACK_DOWNLOAD_URL}
      detectedOs={os}
      installCommand={SPLASH_INSTALL_COMMAND}
      moreOptionsLabel="Choose a different platform"
      // The only action on these screens, so it carries the primary weight.
      // The share splash keeps the outline look, where "Open in desktop app"
      // is the primary and this is the alternative beside it.
      variant="primary"
    />
  );
}

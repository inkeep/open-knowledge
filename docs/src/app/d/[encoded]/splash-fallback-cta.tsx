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

const FALLBACK_DOWNLOAD_URL = downloadRouteForCta('share-splash-fallback');

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
      variant="primary"
    />
  );
}

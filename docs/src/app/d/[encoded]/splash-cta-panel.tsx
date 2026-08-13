'use client';

import { useEffect, useState } from 'react';
import { classifyDownloadOs, type DetectedOs, readPlatformInput } from '@/lib/download-targets';
import { splashDownloadQuery } from '@/lib/share-splash';
import { SplashCtaCluster } from './splash-cta-cluster';

interface SplashCtaPanelProps {
  downloadUrl: string;
  customSchemeUrl: string;
  githubUrl: string;
  installCommand: string;
  cloneCommand: string;
}

/**
 * Progressive-enhancement wrapper around the CTA cluster. The desktop app
 * ships on macOS, Windows, and Linux, so every OS renders the same cluster
 * (deep link + segmented Download button whose panel carries the explicit
 * builds, the CLI commands, and GitHub). The SSR floor is the bare download
 * route (the mac DMG — the historical default); after hydration we classify
 * the OS and keep Windows/Linux on the share-carrying route without guessing
 * until the recipient explicitly chooses a build from the adjacent caret.
 *
 * No-JS / pre-hydration: stays on the SSR floor; the server-rendered Download
 * <a> and GitHub links work without JS (only the panel is JS-gated).
 */
export function SplashCtaPanel({
  downloadUrl,
  customSchemeUrl,
  githubUrl,
  installCommand,
  cloneCommand,
}: SplashCtaPanelProps) {
  const [os, setOs] = useState<DetectedOs>('unknown');

  useEffect(() => {
    setOs(classifyDownloadOs(readPlatformInput()));
  }, []);

  return (
    <SplashCtaCluster
      downloadUrl={splashPrimaryDownloadUrl(downloadUrl, os)}
      platformBaseUrl={downloadUrl}
      detectedOs={os}
      customSchemeUrl={customSchemeUrl}
      githubUrl={githubUrl}
      installCommand={installCommand}
      cloneCommand={cloneCommand}
    />
  );
}

/**
 * Windows/Linux request the picker through the share-carrying route, preserving
 * its pending-share cookie without choosing an architecture. Unknown keeps the
 * working no-JS macOS floor.
 */
export function splashPrimaryDownloadUrl(downloadUrl: string, os: DetectedOs): string {
  return os === 'windows' || os === 'linux'
    ? `${downloadUrl}?picker=1`
    : `${downloadUrl}${splashDownloadQuery(os)}`;
}

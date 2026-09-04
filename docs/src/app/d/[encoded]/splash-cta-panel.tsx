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

export function splashPrimaryDownloadUrl(downloadUrl: string, os: DetectedOs): string {
  return os === 'windows' || os === 'linux'
    ? `${downloadUrl}?picker=1`
    : `${downloadUrl}${splashDownloadQuery(os)}`;
}

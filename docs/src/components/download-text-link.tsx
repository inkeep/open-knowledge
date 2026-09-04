'use client';

import { useEffect, useState } from 'react';
import {
  classifyDownloadOs,
  type DetectedOs,
  downloadHrefForDetectedOs,
  downloadPageHrefForCta,
  readPlatformInput,
} from '@/lib/download-targets';
import type { DownloadCta } from '@/lib/site';

const OS_NOUN: Record<DetectedOs, string> = {
  macos: 'for Mac',
  windows: 'for Windows',
  linux: 'for Linux',
  unknown: '',
};

interface DownloadTextLinkProps {
  cta: DownloadCta;
  className?: string;
}

export function DownloadTextLink({ cta, className }: DownloadTextLinkProps) {
  const [os, setOs] = useState<DetectedOs>('unknown');

  useEffect(() => {
    setOs(classifyDownloadOs(readPlatformInput()));
  }, []);

  const suffix = OS_NOUN[os];
  const href = downloadHrefForDetectedOs(cta, os);
  const pickerHref = downloadPageHrefForCta(cta);

  return (
    <>
      {}
      <a href={href} className={className}>
        Download it{suffix ? ` ${suffix}` : ''}
      </a>
      {}
      {href === pickerHref ? null : (
        <>
          <span className="text-slide-muted"> · </span>
          <a href={pickerHref} className={className}>
            More platforms
          </a>
        </>
      )}
    </>
  );
}

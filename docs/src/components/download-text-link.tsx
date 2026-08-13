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

/**
 * Prose-flow counterpart to the split button, for the places a download sits
 * inside a sentence rather than standing on its own. Same detection and same
 * architecture-safe destination; no dropdown, because a menu can't hang off a
 * run of text.
 *
 * Reads "Download it" until the OS is known and "Download it for Windows"
 * after, so the sentence is never wrong for the reader looking at it.
 */
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
      {/* Raw <a>, never next/link: the SSR target is a 302 handler, and
          prefetching it before OS detection would start a download. */}
      <a href={href} className={className}>
        Download it{suffix ? ` ${suffix}` : ''}
      </a>
      {/* macOS and the neutral SSR floor still point to a concrete build, so
          keep the picker escape hatch. Windows/Linux already land there. */}
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

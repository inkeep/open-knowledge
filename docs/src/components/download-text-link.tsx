'use client';

import { useEffect, useState } from 'react';
import {
  classifyDownloadOs,
  type DetectedOs,
  defaultTargetForOs,
  downloadHrefForTarget,
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
 * tracked redirect; no dropdown, because a menu can't hang off a run of text.
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

  return (
    <>
      {/* Raw <a>, never next/link: the target is a 302 handler and prefetching
          it would fire the redirect. */}
      <a href={downloadHrefForTarget(cta, defaultTargetForOs(os))} className={className}>
        Download it{suffix ? ` ${suffix}` : ''}
      </a>
      {/* A detected OS is still a guess, and this sentence has no dropdown to
          fall back on — without a way out, anyone we guessed wrong for is
          stuck. */}
      <span className="text-slide-muted"> · </span>
      <a href={ALL_PLATFORMS_HREF} className={className}>
        More platforms
      </a>
    </>
  );
}

/** The picker page, which lists every build plus the npm/web-app path. */
const ALL_PLATFORMS_HREF = '/download';

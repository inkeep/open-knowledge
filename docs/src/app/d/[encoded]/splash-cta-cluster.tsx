'use client';

import { useEffect, useRef, useState } from 'react';
import type { DetectedOs } from '@/lib/download-targets';
import { cn } from '@/lib/utils';
import { SplashButtonLabel, splashPrimaryButton } from './splash-buttons';
import { SplashDownloadSplitButton } from './splash-download-split-button';

interface SplashCtaClusterProps {
  downloadUrl: string;
  platformBaseUrl: string;
  detectedOs: DetectedOs;
  customSchemeUrl: string;
  githubUrl: string;
  installCommand: string;
  cloneCommand: string;
}

const FALLBACK_REVEAL_DELAY_MS = 2500;

export function SplashCtaCluster({
  downloadUrl,
  platformBaseUrl,
  detectedOs,
  customSchemeUrl,
  githubUrl,
  installCommand,
  cloneCommand,
}: SplashCtaClusterProps) {
  const [attempting, setAttempting] = useState(false);
  const [handoffFailed, setHandoffFailed] = useState(false);
  const attemptCleanupRef = useRef<(() => void) | null>(null);
  const fallbackCtaRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => () => attemptCleanupRef.current?.(), []);

  useEffect(() => {
    if (handoffFailed) fallbackCtaRef.current?.focus();
  }, [handoffFailed]);

  const handleOpenClick = () => {
    attemptCleanupRef.current?.();
    setHandoffFailed(false);
    setAttempting(true);

    function cleanup() {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onHandoffSignal);
      window.removeEventListener('blur', onHandoffSignal);
      attemptCleanupRef.current = null;
      setAttempting(false);
    }

    function onHandoffSignal() {
      cleanup();
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') cleanup();
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onHandoffSignal);
    window.addEventListener('blur', onHandoffSignal);

    const timer = setTimeout(() => {
      cleanup();
      if (document.visibilityState === 'visible') setHandoffFailed(true);
    }, FALLBACK_REVEAL_DELAY_MS);

    attemptCleanupRef.current = cleanup;
  };

  return (
    <div className="mt-12">
      <div className="flex flex-wrap items-center gap-4">
        <a
          href={customSchemeUrl}
          onClick={handleOpenClick}
          data-testid="splash-open-cta"
          className={cn(splashPrimaryButton, 'touch-manipulation')}
        >
          <SplashButtonLabel>{attempting ? 'Opening…' : 'Open in desktop app'}</SplashButtonLabel>
        </a>

        {}
        <SplashDownloadSplitButton
          downloadUrl={downloadUrl}
          platformBaseUrl={platformBaseUrl}
          detectedOs={detectedOs}
          githubUrl={githubUrl}
          installCommand={installCommand}
          cloneCommand={cloneCommand}
          downloadRef={fallbackCtaRef}
        />
      </div>

      <div aria-live="polite">
        {handoffFailed ? (
          <p className="mt-4 text-sm text-slide-muted" data-testid="splash-handoff-fallback">
            Looks like the desktop app isn&rsquo;t installed yet — use the{' '}
            <span className="font-medium text-slide-text">Download</span> button above.
          </p>
        ) : null}
      </div>
    </div>
  );
}

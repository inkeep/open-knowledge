'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { SplashButtonLabel, splashPrimaryButton } from './splash-buttons';
import { SplashDownloadSplitButton } from './splash-download-split-button';

interface SplashCtaClusterProps {
  downloadUrl: string;
  customSchemeUrl: string;
  githubUrl: string;
  installCommand: string;
  cloneCommand: string;
}

/**
 * How long after firing the custom scheme before we assume no handler is
 * registered. Long enough to ride out a slow app cold-launch; short enough
 * that a user staring at a silent no-op (Chrome's behavior for unregistered
 * schemes) gets the download path without hunting for it.
 */
const FALLBACK_REVEAL_DELAY_MS = 2500;

/**
 * Primary "Open in macOS app" CTA + a segmented Download button that carries
 * the secondary open-paths (copyable CLI commands, View on GitHub) in its
 * dropdown panel.
 *
 * "Open in macOS app" fires the custom-scheme URL via a plain `<a href>` —
 * works regardless of repo visibility (the receiver's local OK auth handles
 * access). Browsers expose no API to ask whether a custom scheme has a
 * registered handler (deliberate anti-fingerprinting), so install detection is
 * post-hoc: fire the scheme, then watch for the OS taking over (blur /
 * visibilitychange / pagehide). If none of those fire within the delay window,
 * the scheme almost certainly had no handler — we surface a "not installed
 * yet" note and move focus onto the always-present Download segment.
 *
 * The fallback is a *reveal*, never a navigation: when the app IS installed,
 * Chrome's "Open …app?" confirmation can keep the page visible past the timer,
 * and auto-navigating to the DMG would yank installed users away
 * mid-confirmation. A stray note is harmless; a stray download is not.
 *
 * The Download segment is server-rendered, so first-time visitors (and no-JS
 * clients) always have a direct download path without sitting through a failed
 * handoff attempt.
 */
export function SplashCtaCluster({
  downloadUrl,
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

  // Keyboard users get no cue from the aria-live announcement alone; move
  // focus onto the revealed download CTA so it's the next actionable thing.
  useEffect(() => {
    if (handoffFailed) fallbackCtaRef.current?.focus();
  }, [handoffFailed]);

  // No preventDefault: the anchor's native navigation fires the scheme even
  // when hydration hasn't completed; this handler only arms the detector.
  const handleOpenClick = () => {
    attemptCleanupRef.current?.();
    // A retry (e.g. after installing the app in another tab) must not show
    // the stale failure notice while a fresh detection window is running.
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

    // Focus or visibility leaving the page means the OS took the handoff
    // (app launched, or the browser's open-app dialog grabbed focus) —
    // suppress the fallback. A user manually tabbing away also lands here;
    // that false negative is covered by the always-visible download link.
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
          <SplashButtonLabel>{attempting ? 'Opening…' : 'Open in macOS app'}</SplashButtonLabel>
        </a>

        {/* Download + the secondary open-paths (copyable CLI commands, GitHub)
            condensed into one segmented control. fallbackCtaRef lands focus on
            the download segment when the deep-link handoff times out. */}
        <SplashDownloadSplitButton
          downloadUrl={downloadUrl}
          githubUrl={githubUrl}
          installCommand={installCommand}
          cloneCommand={cloneCommand}
          downloadRef={fallbackCtaRef}
        />
      </div>

      <div aria-live="polite">
        {handoffFailed ? (
          <p className="mt-4 text-sm text-slide-muted" data-testid="splash-handoff-fallback">
            Looks like the macOS app isn&rsquo;t installed yet — use{' '}
            <span className="font-medium text-slide-text">Download the app</span> above.
          </p>
        ) : null}
      </div>
    </div>
  );
}

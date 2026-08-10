import { Trans } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { OkBlobRunner } from '@/components/OkBlobRunner';

/**
 * The blob runner as a full-pane surface. Mounted by `EditorArea` for a
 * blob-runner new-tab placeholder, so it reads as a real tab rather than a
 * modal floating over the editor.
 *
 * Keyboard is on here: unlike the error screens, nothing in this pane competes
 * for Space the way a focused "Try again" button does.
 */
interface OkBlobRunnerPageProps {
  /** Begin a run on mount. True on the reveal paths, false from menu/palette. */
  autoStart?: boolean;
}

export function OkBlobRunnerPage({ autoStart = false }: OkBlobRunnerPageProps = {}) {
  const pageRef = useRef<HTMLDivElement>(null);

  // Opening from the Resources menu leaves focus on that menu's trigger, because
  // Radix restores it when the popover closes. The runner's key handler stands
  // down while a control holds focus, so Space would go to the trigger and
  // reopen the menu instead of starting the game. Move focus onto the page
  // container — the same focus hand-off an SPA does on navigation — so the
  // keyboard belongs to the game the moment the tab appears.
  useEffect(() => {
    pageRef.current?.focus();
  }, []);

  return (
    <div
      ref={pageRef}
      tabIndex={-1}
      className="flex h-full w-full flex-col items-center justify-center gap-8 px-6 py-8 outline-none"
    >
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-2xl font-light tracking-tighter text-balance">
          <Trans>Blob Run</Trans>
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          <Trans>Space to jump, down arrow to duck. That is the whole game.</Trans>
        </p>
      </div>
      {/* Deliberately uncapped: track width IS reaction time here, so the game
        takes the full pane rather than sitting in a column. */}
      <div className="w-full">
        <OkBlobRunner autoStart={autoStart} />
      </div>
    </div>
  );
}

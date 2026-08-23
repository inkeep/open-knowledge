/**
 * Surfaces branch-driven content recycles (see `lib/branch-recycle-notice.ts`).
 *
 * Two modes:
 *   - **switch** (amber, transient): a branch switch is re-syncing content.
 *     Feedback for the moment every open doc blanks and reloads — previously
 *     silent, and read as "my content disappeared".
 *   - **refused** (red, persistent): the server repeatedly refused this
 *     window's content sessions with `branch-mismatch` and a server-info
 *     refresh did not resolve it — the state that used to render the whole
 *     app empty with no explanation. Names the remedy instead.
 *
 * Occupies the same fixed top strip as `ConnectingBanner`; the two are
 * mutually exclusive in practice (recycle notices only exist while a collab
 * URL is resolved, the connecting banner only while it is not).
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useDocumentContext } from '@/editor/DocumentContext';
import { BRANCH_SWITCH_NOTICE_MS, computeRecycleBannerMode } from '@/lib/branch-recycle-notice';
import { restartCollabServer } from '@/lib/restart-collab-server';

export function BranchRecycleBanner() {
  const { contentRecycleNotice, dismissContentRecycleNotice } = useDocumentContext();
  const [restarting, setRestarting] = useState(false);
  // The effect timer owns the clock (render must stay pure): the transient
  // notice hides itself by flipping this flag at its expiry.
  const [switchExpired, setSwitchExpired] = useState(false);
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;

  useEffect(() => {
    setSwitchExpired(false);
    if (contentRecycleNotice?.kind !== 'branch-switch') return;
    const remaining = Math.max(0, contentRecycleNotice.at + BRANCH_SWITCH_NOTICE_MS - Date.now());
    const timer = setTimeout(() => setSwitchExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [contentRecycleNotice]);

  const mode = computeRecycleBannerMode(contentRecycleNotice, switchExpired);
  if (mode === 'hidden') return null;

  if (mode === 'switch') {
    const branch =
      contentRecycleNotice?.kind === 'branch-switch' ? contentRecycleNotice.branch : '';
    return (
      <div
        role="status"
        data-testid="branch-recycle-banner-switch"
        className="fixed top-0 inset-x-0 z-50 bg-amber-500/95 text-amber-950 text-sm text-center py-2 px-4 ps-[var(--ok-titlebar-reserve-left,1rem)] shadow-md"
      >
        <Trans>
          Server switched to branch <code className="bg-amber-100/60 px-1 rounded">{branch}</code> —
          reloading content
        </Trans>
      </div>
    );
  }

  const handleRestart = async () => {
    if (!bridge) return;
    setRestarting(true);
    try {
      const result = await restartCollabServer(bridge);
      // Success tears this window down; only a resolved failure re-enables.
      if (!result.ok) setRestarting(false);
    } catch {
      setRestarting(false);
    }
  };

  return (
    <div
      role="alert"
      data-testid="branch-recycle-banner-refused"
      className="fixed top-0 inset-x-0 z-50 bg-red-500/95 text-red-950 text-sm text-center py-2 px-4 ps-[var(--ok-titlebar-reserve-left,1rem)] shadow-md flex items-center justify-center gap-3 flex-wrap"
    >
      <span>
        <Trans>
          The project's server is on a different branch than this window — content can't load.
        </Trans>
      </span>
      {bridge ? (
        <Button
          size="sm"
          onClick={handleRestart}
          disabled={restarting}
          className="h-6 bg-red-950 text-red-50 px-2 text-xs font-medium hover:bg-red-900"
        >
          {restarting ? <Trans>Restarting</Trans> : <Trans>Restart server</Trans>}
        </Button>
      ) : null}
      <Button
        size="sm"
        onClick={() => window.location.reload()}
        className="h-6 bg-red-950 text-red-50 px-2 text-xs font-medium hover:bg-red-900"
      >
        <Trans>Reload</Trans>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={dismissContentRecycleNotice}
        aria-label={t`Dismiss`}
        className="h-6 px-2 text-xs text-red-950 hover:bg-red-400/40"
      >
        <Trans>Dismiss</Trans>
      </Button>
    </div>
  );
}

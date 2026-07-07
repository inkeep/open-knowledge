/**
 * Config-sharing section — the per-project shared / local-only toggle for the
 * OK config artifact set.
 *
 * Two-state segmented control: `Shared` vs `Local only`. Toggling routes
 * through `bridge.sharing.setMode` which calls the same
 * `addOkPathsToGitExclude` / `removeOkPathsFromGitExclude` primitives the CLI
 * uses, so desktop and CLI cannot drift.
 *
 * Refusal: when the toggle to `local-only` hits a tracked-upstream OK
 * file, main returns `kind: 'refused-tracked'` with the full
 * remediation. We render it in an inline alert + a sticky toast so the
 * user has time to copy the `git rm --cached` commands.
 *
 * No git: when the project has no git repo, the toggle is disabled with
 * a tooltip explanation.
 *
 * Web / non-Electron: `bridge` is undefined; the section renders a
 * read-only "available in the desktop app" stub.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ConfigSharingInfoTooltip } from '@/components/ConfigSharingInfoTooltip';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import type { OkSharingStatusResult } from '@/lib/desktop-bridge-types';

const TITLE_ID = 'settings-sharing-title';

export function SharingSection() {
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const sharingBridge = bridge?.sharing;
  return sharingBridge !== undefined ? <SharingSectionBody /> : <SharingSectionUnsupported />;
}

function SharingSectionUnsupported() {
  return (
    <section aria-labelledby={TITLE_ID} className="space-y-3">
      <div className="space-y-1">
        <h3 id={TITLE_ID} className="text-base font-semibold">
          <Trans>Config sharing</Trans>
        </h3>
        <p className="text-1sm text-muted-foreground">
          <Trans>
            Available in the OpenKnowledge desktop app. From a terminal, use
            <code> ok config-sharing status</code> / <code>share</code> / <code>unshare</code>.
          </Trans>
        </p>
      </div>
    </section>
  );
}

function SharingSectionBody() {
  const { t } = useLingui();
  const [status, setStatus] = useState<OkSharingStatusResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{
    tracked: readonly string[];
    remediation: string;
  } | null>(null);

  async function refresh() {
    const bridge = window.okDesktop?.sharing;
    if (!bridge) return;
    try {
      setStatus(await bridge.status());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t`Config sharing status read failed`);
      // Don't strand the initial mount in the Skeleton if `bridge.status()`
      // itself rejects (IPC teardown on window close, stale bridge): with no
      // status yet, fall back to a safe `no-git` reading so the section
      // renders (the toast already surfaced the real error). A later refresh
      // failure keeps the last good status rather than clobbering it.
      setStatus(
        (prev) => prev ?? { kind: 'status', mode: 'no-git', excluded: [], trackedUpstream: [] },
      );
    }
  }

  // Initial fetch on mount. React Compiler optimizes the closure capture
  // of `refresh`; manual useCallback is intentionally omitted per the
  // codebase's compiler-first convention.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is a stable closure under React Compiler — adding it to deps would force the manual-memoization pattern the codebase explicitly rejects.
  useEffect(() => {
    void refresh();
  }, []);

  async function onSelect(mode: 'shared' | 'local-only') {
    const bridge = window.okDesktop?.sharing;
    if (!bridge || status === null || busy) return;
    if (status.mode === mode) return; // no-op selection — current state
    setBusy(true);
    setRefusal(null);
    let result: Awaited<ReturnType<typeof bridge.setMode>> | null = null;
    let err: unknown = null;
    try {
      result = await bridge.setMode(mode);
    } catch (caught) {
      err = caught;
    }
    setBusy(false);
    if (err !== null) {
      toast.error(err instanceof Error ? err.message : t`Config sharing toggle failed`);
      return;
    }
    if (result === null) return;
    if (result.kind === 'refused-tracked') {
      setRefusal({ tracked: result.tracked, remediation: result.remediation });
      // The inline alert below renders the full remediation; keep the toast a
      // brief, auto-dismissing pointer to it rather than a second copy (the
      // settings panel is already showing the details inline).
      toast.error(t`Config sharing unchanged — see details below.`, { duration: 5000 });
    } else if (result.kind === 'no-exclude') {
      toast.warning(
        result.reason === 'no-git'
          ? t`No git repository — config sharing does not apply here.`
          : t`Config sharing unavailable: ${result.reason}.`,
      );
    } else {
      toast.success(
        mode === 'local-only'
          ? t`Config sharing is now local-only.`
          : t`Config sharing is now shared. Commit the OK files to share with your team.`,
      );
    }
    await refresh();
  }

  if (status === null) {
    return (
      <section aria-labelledby={TITLE_ID} className="space-y-3">
        <h3 id={TITLE_ID} className="text-base font-semibold">
          <Trans>Config sharing</Trans>
        </h3>
        <Skeleton className="h-24" />
      </section>
    );
  }

  const noGit = status.mode === 'no-git';

  return (
    <section aria-labelledby={TITLE_ID} className="space-y-4" data-testid="settings-sharing">
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <h3 id={TITLE_ID} className="text-base font-semibold">
            <Trans>Config sharing</Trans>
          </h3>
          <ConfigSharingInfoTooltip />
        </div>
        <p className="text-1sm text-muted-foreground">
          <Trans>
            Choose whether this project's OpenKnowledge setup, including its AI-tool connections, is
            saved with the project so teammates get it too, or kept only on your computer.
          </Trans>
        </p>
      </div>

      {noGit ? (
        <p
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          role="status"
          data-testid="settings-sharing-no-git"
        >
          <Trans>
            This project has no git repository — sharing mode does not apply. Initialize a repo to
            enable the toggle.
          </Trans>
        </p>
      ) : (
        <RadioGroup
          value={status.mode}
          onValueChange={(v) => void onSelect(v as 'shared' | 'local-only')}
          disabled={busy}
          className="gap-2"
          aria-labelledby={TITLE_ID}
          data-testid="settings-sharing-radiogroup"
        >
          <label htmlFor="settings-sharing-shared" className="flex items-start gap-2 text-sm">
            <RadioGroupItem
              id="settings-sharing-shared"
              value="shared"
              data-testid="settings-sharing-shared"
              className="mt-1"
            />
            <span>
              <span className="font-medium">
                <Trans>Shared</Trans>
              </span>
              <span className="block text-1sm text-muted-foreground">
                <Trans>Saved with the project for your team.</Trans>
              </span>
            </span>
          </label>
          <label htmlFor="settings-sharing-local-only" className="flex items-start gap-2 text-sm">
            <RadioGroupItem
              id="settings-sharing-local-only"
              value="local-only"
              data-testid="settings-sharing-local-only"
              className="mt-1"
            />
            <span>
              <span className="font-medium">
                <Trans>Local only</Trans>
              </span>
              <span className="block text-1sm text-muted-foreground">
                <Trans>Stays on this computer.</Trans>
              </span>
            </span>
          </label>
        </RadioGroup>
      )}

      {refusal !== null ? (
        <div
          className="space-y-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm"
          role="alert"
          data-testid="settings-sharing-refusal"
        >
          <p className="font-semibold">
            <Trans>Switch to local-only refused</Trans>
          </p>
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
            {refusal.remediation}
          </pre>
          <Button variant="outline" size="sm" onClick={() => setRefusal(null)}>
            <Trans>Dismiss</Trans>
          </Button>
        </div>
      ) : null}

      {status.trackedUpstream.length > 0 && status.mode !== 'no-git' && refusal === null ? (
        <div
          className="space-y-1 rounded-md border border-muted-foreground/30 bg-muted/40 p-3 text-sm"
          data-testid="settings-sharing-tracked-info"
        >
          <p className="font-medium">
            <Trans>Other OK paths are tracked upstream:</Trans>
          </p>
          <ul className="list-disc pl-5 font-mono text-xs text-muted-foreground">
            {status.trackedUpstream.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="text-1sm text-muted-foreground">
            <Trans>
              Switching to <code>local-only</code> will refuse until they're untracked via
              <code> git rm --cached</code>.
            </Trans>
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Settings → Search — opt-in semantic (embeddings) ranking for the MCP search
 * tool. Per-machine (project-local scope) because enabling it sends content to
 * a third-party embeddings provider; each teammate opts in deliberately on
 * their own machine rather than inheriting one collaborator's egress choice
 * through git.
 *
 * The toggle reads the synchronous project-local CRDT preference (the same
 * pattern as the Sync section's Switch — never the server's resolved state,
 * which round-trips through the persistence debounce + config file-watcher and
 * would make the control appear to lag). Every off → on transition is gated by
 * a confirmation dialog that discloses the egress; on → off commits immediately
 * (the safe direction).
 *
 * The status panel below the toggle derives from the server's
 * `GET /api/semantic-status` probe (`keyPresent` / `ready` / `capable`). The key
 * is never set here — it's a machine-global credential managed in Settings →
 * Account (stored in `~/.ok/secrets.yml`); this section only points there when a
 * key is missing.
 */
import { humanFormat } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  Dialog as DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { useSemanticSearchStatus } from '@/hooks/use-semantic-search-status';
import { useConfigContext } from '@/lib/config-provider';

// Refetch `/api/semantic-status` at these delays (ms) after a toggle so the
// coverage panel repaints once the persistence debounce + config file-watcher
// have carried the new `search.semantic.enabled` into the server. The `files`
// CC1 channel doesn't fire for config-doc edits, so this is the catch-up path.
const SETTLE_REFRESH_DELAYS_MS = [2500, 5000] as const;

export function SearchSection() {
  const { t } = useLingui();
  const { projectLocalConfig, projectLocalSynced, projectLocalBinding } = useConfigContext();
  const { status, refresh } = useSemanticSearchStatus();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const settleTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(
    () => () => {
      for (const timer of settleTimersRef.current) clearTimeout(timer);
    },
    [],
  );

  const enabled = projectLocalConfig?.search?.semantic?.enabled ?? false;
  const bindingReady = projectLocalSynced && projectLocalBinding !== null;

  function scheduleSettleRefresh() {
    for (const timer of settleTimersRef.current) clearTimeout(timer);
    settleTimersRef.current = SETTLE_REFRESH_DELAYS_MS.map((delay) => setTimeout(refresh, delay));
  }

  function write(next: boolean): boolean {
    if (projectLocalBinding === null) {
      toast.error(t`Search settings not yet loaded — try again in a moment`);
      return false;
    }
    const result = projectLocalBinding.patch({ search: { semantic: { enabled: next } } });
    if (!result.ok) {
      const detail = humanFormat(result.error);
      toast.error(
        next
          ? t`Failed to enable semantic search — ${detail}`
          : t`Failed to disable semantic search — ${detail}`,
      );
      return false;
    }
    refresh();
    scheduleSettleRefresh();
    return true;
  }

  function onToggleRequest(next: boolean) {
    if (next) {
      // Off → on: gate behind the egress confirmation. On → off is the safe
      // direction and commits immediately.
      setConfirmOpen(true);
      return;
    }
    write(false);
  }

  function onConfirm() {
    // Close only on success so a failed write leaves the dialog open to retry.
    if (write(true)) setConfirmOpen(false);
  }

  // Status derives from the server's resolved view, not the client preference:
  // `serverEnabled` lags the toggle until the file-watcher settles. `keyPresent`
  // is a free, prompt-free read (secrets file / env) so "no key" shows the
  // instant the toggle flips — no waiting for a warm. `ready` = the service has
  // warmed (used for the coverage line); `capable` = warmed AND the key actually
  // worked, so `keyPresent && ready && !capable` is "provider rejected the key".
  const serverEnabled = status?.enabled ?? false;
  const keyPresent = status?.keyPresent ?? false;
  const ready = status?.ready ?? false;
  const capable = status?.capable ?? false;
  const embedded = status?.embedded ?? 0;
  const total = status?.total ?? 0;

  return (
    <section
      aria-labelledby="settings-search-title"
      className="space-y-3"
      data-testid="settings-search"
    >
      <div className="space-y-1">
        <h3 id="settings-search-title" className="text-base font-semibold">
          <Trans>Semantic search</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>
            Add meaning-based ranking to search so conceptually-related pages surface even when they
            share no keywords. This setting applies only to this computer.
          </Trans>
        </p>
      </div>

      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <label htmlFor="settings-search-semantic-toggle" className="text-sm font-medium">
              <Trans>Semantic search</Trans>
            </label>
            <p className="text-muted-foreground text-1sm" data-testid="settings-search-body">
              {enabled ? (
                <Trans>
                  On — your search queries and the text of matching pages are sent to your
                  embeddings provider (OpenAI by default) to compute embeddings.
                </Trans>
              ) : (
                <Trans>Off — search ranks by keyword only. No content leaves this computer.</Trans>
              )}
            </p>
          </div>
          <Switch
            id="settings-search-semantic-toggle"
            checked={enabled}
            disabled={!bindingReady}
            onCheckedChange={onToggleRequest}
            aria-label={enabled ? t`Disable semantic search` : t`Enable semantic search`}
            data-testid="settings-search-semantic-toggle"
          />
        </div>

        {enabled ? (
          <SemanticStatusPanel
            loaded={status !== null}
            serverEnabled={serverEnabled}
            keyPresent={keyPresent}
            ready={ready}
            capable={capable}
            embedded={embedded}
            total={total}
          />
        ) : null}
      </div>

      <EnableSemanticSearchConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={onConfirm}
      />
    </section>
  );
}

interface SemanticStatusPanelProps {
  loaded: boolean;
  serverEnabled: boolean;
  keyPresent: boolean;
  ready: boolean;
  capable: boolean;
  embedded: number;
  total: number;
}

/**
 * Read-only readout under the toggle. States, in order: still settling (server
 * hasn't picked up the toggle), no-key (instant — driven off the free
 * `keyPresent` read, not a warm), provider-rejected-the-key, not-yet-warmed
 * (indexes on first search), and live coverage (with a lazy-embedding note while
 * nothing is embedded yet).
 */
function SemanticStatusPanel({
  loaded,
  serverEnabled,
  keyPresent,
  ready,
  capable,
  embedded,
  total,
}: SemanticStatusPanelProps) {
  if (!loaded || !serverEnabled) {
    return (
      <p
        role="status"
        aria-live="polite"
        className="text-muted-foreground text-1sm mt-2"
        data-testid="settings-search-settling"
      >
        <Trans>Applying your change</Trans>
      </p>
    );
  }

  if (!keyPresent) {
    // No key resolvable — instant (a free file/env read, no warm needed). Point
    // at the canonical home for the machine-global key: Settings → Account.
    return (
      <div
        role="alert"
        className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-1sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        data-testid="settings-search-needs-key"
      >
        <Trans>
          Semantic search is on, but no API key is set — search falls back to keyword matching. Add
          one in <span className="font-medium">Settings → Account</span> (it's stored once for your
          whole machine).
        </Trans>
      </div>
    );
  }

  if (ready && !capable) {
    // A key is present and the service warmed, but the embedder failed to load —
    // a bad key or an unreachable provider. Distinct from "no key" above.
    return (
      <div
        role="alert"
        className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-1sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        data-testid="settings-search-provider-error"
      >
        <Trans>
          A key is set, but the embeddings provider rejected it or was unreachable — search fell
          back to keyword matching. Check the key in{' '}
          <span className="font-medium">Settings → Account</span> and your provider settings.
        </Trans>
      </div>
    );
  }

  if (!ready) {
    return (
      <p
        role="status"
        className="text-muted-foreground text-1sm mt-2"
        data-testid="settings-search-pending"
      >
        <Trans>Semantic ranking activates the first time an agent runs a search.</Trans>
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-0.5" data-testid="settings-search-coverage">
      <p className="text-muted-foreground text-1sm">
        <Trans>
          Indexed {embedded} of {total} pages.
        </Trans>
      </p>
      {embedded === 0 ? (
        <p className="text-muted-foreground text-1sm">
          <Trans>Pages are embedded the first time a search needs them.</Trans>
        </p>
      ) : null}
    </div>
  );
}

interface EnableSemanticSearchConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/**
 * Guards every off → on transition. The egress disclosure is the load-bearing
 * content — turning semantic search on is the moment content first leaves the
 * machine, so the dialog spells out what is sent, where, and that it's
 * per-machine.
 */
function EnableSemanticSearchConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: EnableSemanticSearchConfirmDialogProps) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="settings-search-confirm">
        <DialogHeader>
          <DialogTitle>
            <Trans>Turn on semantic search?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Semantic search adds meaning-based ranking to the search tool so conceptually-related
              pages surface even without shared keywords.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div
            role="alert"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          >
            <p className="mb-2 font-medium">
              <Trans>This sends content off your machine</Trans>
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <Trans>
                  Your search queries and the full text of matching pages are sent to your
                  embeddings provider (OpenAI by default) to compute embeddings.
                </Trans>
              </li>
              <li>
                <Trans>
                  Embeddings are computed only when a search runs and are cached locally under{' '}
                  <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs dark:bg-amber-900">
                    .ok/local
                  </code>
                  .
                </Trans>
              </li>
              <li>
                <Trans>
                  This setting is per-machine and isn't shared with collaborators. It needs an API
                  key set with{' '}
                  <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs dark:bg-amber-900">
                    ok embeddings set-key
                  </code>
                  .
                </Trans>
              </li>
            </ul>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button onClick={onConfirm} data-testid="settings-search-confirm-enable">
            <Trans>Turn on</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

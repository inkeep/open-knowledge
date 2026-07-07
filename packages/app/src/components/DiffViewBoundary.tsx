/**
 * DiffViewBoundary — peer of the editor branch inside each `<Activity>`
 * slot of EditorActivityPool. Mounted when the active doc's
 * `lifecycle.status === 'conflict'`. Sibling to (NOT a replacement of) the
 * editor `DocumentBoundary` mount; the hybrid render tree per
 * precedent #18(b) stays intact.
 *
 * Responsibilities:
 *   1. Provider-sync gating is inherited from the outer `DocumentBoundary`
 *      wrap (the conditional swap happens INSIDE that boundary's children),
 *      so Suspense / error scopes compose unchanged.
 *   2. Fetch `GET /api/sync/conflict-content?file=<path>&source=ytext` for
 *      `ours` + `theirs`. The server's `?source=ytext` branch prefers the
 *      live Y.Text snapshot for `ours` (preserves pre-conflict unflushed
 *      edits) and falls back to git-index (`git show :2:`) when Y.Text
 *      contains conflict markers — which happens on editor reopen because
 *      the file watcher seeds Y.Text with the disk's marker bytes.
 *      `theirs` always comes from `git show :3:`.
 *   3. Render `<DiffView conflictMode oldContent={theirs} newContent={ours}
 *      layout="unified" onResolve />`. Resolution dispatches the merged
 *      content via the DiffView's "Save resolution" button.
 *   4. Emit `editor-area-swap-to-diffview` / `editor-area-swap-from-diffview`
 *      structured log events on mount / unmount.
 */
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useConflictFooterHeightVar } from '@/hooks/use-conflict-footer-height';
import { useConflicts } from '@/hooks/use-conflicts';
import { filePathToDocName } from '@/lib/doc-hash';
import { DiffView } from './DiffView';
import {
  resolveConflictContent,
  resolveConflictDelete,
  resolveConflictMine,
  resolveConflictTheirs,
} from './resolve-conflict-dispatch';

interface DiffViewBoundaryProps {
  docName: string;
  provider: HocuspocusProvider;
}

type ConflictKind = 'both-modified' | 'delete-modify' | 'modify-delete';

interface ConflictSides {
  base: string;
  ours: string;
  theirs: string;
  /**
   * Stage-presence discriminator derived server-side. `'both-modified'` is
   * the classical merge conflict; `'delete-modify'` (DU) has no stage 2
   * (local deleted); `'modify-delete'` (UD) has no stage 3 (remote deleted).
   */
  kind: ConflictKind;
}

async function fetchConflictSides(file: string): Promise<ConflictSides | null> {
  try {
    const res = await fetch(
      `/api/sync/conflict-content?file=${encodeURIComponent(file)}&source=ytext`,
    );
    if (!res.ok) {
      let detail: string | undefined;
      try {
        const payload = (await res.json()) as { detail?: unknown; title?: unknown };
        if (typeof payload.detail === 'string') detail = payload.detail;
        else if (typeof payload.title === 'string') detail = payload.title;
      } catch {
        // ignore body parse error — surface bare HTTP status
      }
      // Structured warn — pairs with the swap-in/swap-out events so
      // server-side log correlation has a complete trace of editor-area
      // lifecycle when the user reports "blank conflict pane".
      console.warn(
        JSON.stringify({
          event: 'conflict-content-fetch-failed',
          file,
          status: res.status,
          detail,
        }),
      );
      return null;
    }
    const data = (await res.json()) as Partial<ConflictSides>;
    // Default to `'both-modified'` for stale-cache resilience only — the
    // current server always populates `kind`; this fallback exists for
    // mid-rollout clients hitting an older server response.
    const kind: ConflictKind =
      data.kind === 'delete-modify' ||
      data.kind === 'modify-delete' ||
      data.kind === 'both-modified'
        ? data.kind
        : 'both-modified';
    // `kind !== data.kind` exactly when the fallback fired — the server
    // always sends a recognized discriminator, so reaching here means a
    // version-skewed/older server (or a proxy that stripped the field).
    // The fallback shape is safe (renders the diff, no destructive
    // affordance), but a DU/UD conflict would silently render the wrong
    // UI; emit a structured trace so a "wrong conflict pane" report
    // correlates with the swap-in/out + fetch-failed events.
    if (data.kind !== kind) {
      console.warn(
        JSON.stringify({
          event: 'conflict-kind-missing-fallback',
          file,
          receivedKind: data.kind ?? null,
        }),
      );
    }
    return {
      base: data.base ?? '',
      ours: data.ours ?? '',
      theirs: data.theirs ?? '',
      kind,
    };
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'conflict-content-fetch-failed',
        file,
        status: null,
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

export function DiffViewBoundary({ docName }: DiffViewBoundaryProps) {
  const { t } = useLingui();
  // `.mdx` docs are conflict-trackable too — `SUPPORTED_DOC_EXTENSIONS`
  // covers both. The HTTP file-path (conflict-content fetch + resolve
  // dispatch) must use the on-disk extension; the docName is extension-less.
  // The conflicts list (`useConflicts()`) is the only client-side source of
  // the on-disk path, so look it up there. Two propagation paths race:
  // the per-doc lifecycle Y.Map (mounts this component) propagates faster
  // than the CC1 `sync-status` signal that triggers `useConflicts()` to
  // re-fetch `/api/sync/conflicts`. Without deferring, an `.mdx` doc in a
  // newly-detected conflict would fire a wrong-extension `.md` request
  // and flash the error fallback before the conflicts list catches up.
  const { conflicts, loading: conflictsLoading } = useConflicts();
  const conflictEntry = conflicts.find((entry) => filePathToDocName(entry.file) === docName);
  const filePath = conflictEntry?.file ?? `${docName}.md`;
  const [sides, setSides] = useState<ConflictSides | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  // Guards the DU/UD resolve buttons against double-fire / cross-strategy
  // clicks while a dispatch is in flight — these run `git rm` + a commit,
  // so a second click (or clicking the sibling strategy) mid-request races
  // the working tree. The both-modified DiffView has its own interaction
  // model; only the bare-button branches need this gate.
  const [isResolving, setIsResolving] = useState(false);
  // The DU/UD branches render their own resolution footers (outside
  // DiffView's conflictMode footer), so they publish the footer height the
  // floating Ask AI composer anchors above — same contract as the
  // both-modified footer inside DiffView. See use-conflict-footer-height.ts.
  const duUdFooterRef = useConflictFooterHeightVar(
    sides?.kind === 'delete-modify' || sides?.kind === 'modify-delete',
  );

  // Structured log: swap-in on mount, swap-out on unmount.
  useEffect(() => {
    console.warn(JSON.stringify({ event: 'editor-area-swap-to-diffview', 'doc.name': docName }));
    return () => {
      console.warn(
        JSON.stringify({ event: 'editor-area-swap-from-diffview', 'doc.name': docName }),
      );
    };
  }, [docName]);

  // Fetch ours/theirs from the server (git index — `:2:` and `:3:`).
  //
  // Defer the fetch until the conflicts list provides this doc's entry.
  // Per-doc check (`conflictEntry === undefined`), not list-level
  // (`conflicts.length === 0`): in a multi-conflict merge where other
  // entries have loaded but this doc's hasn't, list-level wouldn't defer
  // and the effect would fire with the hardcoded `.md` fallback —
  // wrong for `.mdx` docs. The deferral self-heals on the next CC1
  // `sync-status` signal; if the entry never arrives the user sees
  // the loading spinner and the documented recovery procedure applies.
  const deferFetch = conflictsLoading || conflictEntry === undefined;
  useEffect(() => {
    if (deferFetch) return;
    let cancelled = false;
    setSides(null);
    setFetchFailed(false);
    void fetchConflictSides(filePath).then((result) => {
      if (cancelled) return;
      if (result === null) {
        setFetchFailed(true);
      } else {
        setSides(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, deferFetch]);

  async function handleResolve(content: string) {
    const result = await resolveConflictContent(filePath, content);
    if (!result.ok) {
      toast.error(t`Couldn't save the resolution for ${filePath}.`, { description: result.detail });
    }
  }

  async function handleResolveStrategy(
    dispatch: (file: string) => Promise<{ ok: boolean; detail?: string }>,
  ) {
    setIsResolving(true);
    const result = await dispatch(filePath);
    if (!result.ok) {
      // Re-enable for retry. On success the conflict clears and this
      // boundary unmounts, so we intentionally leave the buttons disabled
      // in that window rather than set state on an unmounting tree.
      setIsResolving(false);
      toast.error(t`Couldn't resolve the conflict for ${filePath}.`, {
        description: result.detail,
      });
    }
  }

  if (fetchFailed) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        <Trans>Couldn't load conflict content for {filePath}. Try reloading the page.</Trans>
      </div>
    );
  }

  if (sides === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        <Trans>Loading conflict for {filePath}</Trans>
      </div>
    );
  }

  // Stage-presence-aware render branching. The `kind` discriminator carries
  // from the server's `/api/sync/conflict-content` response — see
  // `SyncConflictContentSuccessSchema`. The two missing-stage shapes (DU,
  // UD) need an explicit affordance the unified `DiffView` cannot honestly
  // surface; the both-modified path is unchanged.
  if (sides.kind === 'delete-modify') {
    return (
      // Content / footer layout — no top header. The explanatory text
      // moved into the footer next to the buttons (inline compact label)
      // so context lives adjacent to the decision and the parent's
      // `pt-14` doesn't push a top banner down. `min-h-0` on the content
      // row is load-bearing — without it, `flex-1` won't shrink below
      // the editor's intrinsic height and the page scrolls instead of
      // the inner editor.
      <div className="flex h-full flex-col bg-background">
        <div className="min-h-0 flex-1">
          <DiffView oldContent="" newContent={sides.theirs} layout="unified" previewMode />
        </div>
        <div
          ref={duUdFooterRef}
          className="flex flex-shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t px-6 py-4"
        >
          <p className="text-sm text-muted-foreground">
            <Trans>
              You deleted <span className="font-medium text-foreground">{filePath}</span> locally,
              but it was modified upstream.
            </Trans>
          </p>
          <div className="flex shrink-0 gap-3">
            <Button
              type="button"
              variant="destructive"
              disabled={isResolving}
              onClick={() => void handleResolveStrategy(resolveConflictDelete)}
            >
              {/* Describes the END-STATE (the file remains deleted), not
                  an action verb. "Keep deletion" was ambiguous — it could
                  read as "perform a deletion" on first glance. Destructive
                  button, so clarity-of-outcome matters. Companion CTA is
                  "Restore with remote changes" — symmetric outcome-language. */}
              <Trans>Keep file deleted</Trans>
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={isResolving}
              onClick={() => void handleResolveStrategy(resolveConflictTheirs)}
            >
              <Trans>Restore with remote changes</Trans>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (sides.kind === 'modify-delete') {
    return (
      // Symmetric to the DU branch. Inline compact label in the
      // footer; content preview is the user's local file (`ours`) — what
      // they'd lose if they accept the upstream deletion.
      <div className="flex h-full flex-col bg-background">
        <div className="min-h-0 flex-1">
          <DiffView oldContent="" newContent={sides.ours} layout="unified" previewMode />
        </div>
        <div
          ref={duUdFooterRef}
          className="flex flex-shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t px-6 py-4"
        >
          <p className="text-sm text-muted-foreground">
            <Trans>
              You modified <span className="font-medium text-foreground">{filePath}</span> locally,
              but it was deleted upstream.
            </Trans>
          </p>
          <div className="flex shrink-0 gap-3">
            <Button
              type="button"
              variant="default"
              disabled={isResolving}
              onClick={() => void handleResolveStrategy(resolveConflictMine)}
            >
              <Trans>Keep my version</Trans>
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isResolving}
              onClick={() => void handleResolveStrategy(resolveConflictDelete)}
            >
              <Trans>Accept their deletion</Trans>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <DiffView
      oldContent={sides.theirs}
      newContent={sides.ours}
      layout="unified"
      conflictMode
      onResolve={(content) => void handleResolve(content)}
    />
  );
}

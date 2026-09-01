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
 *   3. Render `<ConflictView ours theirs base onResolve />` for both-modified
 *      conflicts. ConflictView owns a Pierre UnresolvedFile instance and
 *      calls onResolve with the resolved content when all hunks are accepted.
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
import { ConflictFilePreview } from './ConflictFilePreview';
import { ConflictView } from './ConflictView';
import {
  resolveConflictContent,
  resolveConflictDelete,
  resolveConflictMine,
  resolveConflictTheirs,
} from './resolve-conflict-dispatch';

const CONFLICT_ENTRY_GRACE_MS = 2_000;

interface DiffViewBoundaryProps {
  docName: string;
  provider: HocuspocusProvider;
}

type ConflictKind = 'both-modified' | 'delete-modify' | 'modify-delete';

interface ConflictSides {
  base: string;
  ours: string;
  theirs: string;
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
      } catch {}
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
    const kind: ConflictKind =
      data.kind === 'delete-modify' ||
      data.kind === 'modify-delete' ||
      data.kind === 'both-modified'
        ? data.kind
        : 'both-modified';
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
  const { conflicts, loading: conflictsLoading, error: conflictsError } = useConflicts();
  const conflictEntry = conflicts.find((entry) => filePathToDocName(entry.file) === docName);
  const filePath = conflictEntry?.file ?? `${docName}.md`;
  const [sides, setSides] = useState<ConflictSides | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [waitedForEntry, setWaitedForEntry] = useState(false);
  useEffect(() => {
    if (conflictEntry !== undefined || conflictsLoading || conflictsError !== null) {
      setWaitedForEntry(false);
      return;
    }
    const timer = setTimeout(() => setWaitedForEntry(true), CONFLICT_ENTRY_GRACE_MS);
    return () => clearTimeout(timer);
  }, [conflictEntry, conflictsLoading, conflictsError]);
  const [isResolving, setIsResolving] = useState(false);
  const duUdFooterRef = useConflictFooterHeightVar(
    sides?.kind === 'delete-modify' || sides?.kind === 'modify-delete',
  );

  useEffect(() => {
    console.warn(JSON.stringify({ event: 'editor-area-swap-to-diffview', 'doc.name': docName }));
    return () => {
      console.warn(
        JSON.stringify({ event: 'editor-area-swap-from-diffview', 'doc.name': docName }),
      );
    };
  }, [docName]);

  const conflictSignature =
    conflictEntry === undefined
      ? null
      : [
          conflictEntry.detectedAt,
          conflictEntry.baseSha ?? '',
          conflictEntry.oursSha ?? '',
          conflictEntry.theirsSha ?? '',
        ].join('|');

  const deferFetch = conflictsLoading || conflictEntry === undefined;
  useEffect(() => {
    if (deferFetch || conflictSignature === null) return;
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
  }, [filePath, deferFetch, conflictSignature]);

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

  if (conflictsError !== null && conflictEntry === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        <Trans>Couldn't check whether {filePath} is still conflicted — retrying.</Trans>
      </div>
    );
  }

  if (
    waitedForEntry &&
    !conflictsLoading &&
    conflictsError === null &&
    conflictEntry === undefined
  ) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-sm text-muted-foreground">
        <p>
          <Trans>This conflict is resolved.</Trans>
        </p>
        <p className="text-xs">
          <Trans>Reopen {filePath} to keep editing.</Trans>
        </p>
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

  if (sides.kind === 'delete-modify') {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="min-h-0 flex-1">
          <ConflictFilePreview filename={filePath} content={sides.theirs} />
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
              {}
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
      <div className="flex h-full flex-col bg-background">
        <div className="min-h-0 flex-1">
          <ConflictFilePreview filename={filePath} content={sides.ours} />
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
    <ConflictView
      fileName={filePath}
      ours={sides.ours}
      base={sides.base}
      theirs={sides.theirs}
      onResolve={handleResolve}
    />
  );
}

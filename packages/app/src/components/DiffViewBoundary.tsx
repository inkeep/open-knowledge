import {
  type ConflictEntryWire,
  type ResolveStrategyWire,
  type SyncConflictContentSuccess,
  SyncConflictContentSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useConflictFooterHeightVar } from '@/hooks/use-conflict-footer-height';
import { useConflicts } from '@/hooks/use-conflicts';
import { ConflictFilePreview } from './ConflictFilePreview';
import { ConflictView } from './ConflictView';
import {
  type ResolveConflictResult,
  resolveConflictContent,
  resolveConflictDelete,
  resolveConflictMine,
  resolveConflictTheirs,
} from './resolve-conflict-dispatch';

interface DiffViewBoundaryProps {
  docName: string;
  conflict: ConflictEntryWire;
}

type ConflictShape = 'both-modified' | 'delete-modify' | 'modify-delete';

interface ConflictSides {
  file: string;
  base: string;
  ours: string;
  theirs: string;
  kind: ConflictShape;
  resolutionOptions: readonly ResolveStrategyWire[];
  conflictKind: SyncConflictContentSuccess['conflictKind'];
}

const CONFLICT_CONTENT_REQUEST_TIMEOUT_MS = 20_000;

async function fetchConflictSides(file: string): Promise<ConflictSides | null> {
  try {
    const res = await fetch(
      `/api/sync/conflict-content?file=${encodeURIComponent(file)}&source=ytext`,
      { signal: AbortSignal.timeout(CONFLICT_CONTENT_REQUEST_TIMEOUT_MS) },
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
    const body = await res.json().catch(() => null);
    const parsed = SyncConflictContentSuccessSchema.safeParse(body);
    if (!parsed.success) {
      console.warn(
        JSON.stringify({
          event: 'conflict-content-fetch-failed',
          file,
          status: res.status,
          detail: 'schema-drift',
        }),
      );
      return null;
    }
    return {
      file: parsed.data.file,
      base: parsed.data.base,
      ours: parsed.data.ours,
      theirs: parsed.data.theirs,
      kind: parsed.data.kind,
      resolutionOptions: parsed.data.resolutionOptions,
      conflictKind: parsed.data.conflictKind,
    };
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'conflict-content-fetch-failed',
        file,
        status: null,
        errorName: err instanceof Error ? err.name : 'non-error-throw',
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

export function DiffViewBoundary({ docName, conflict }: DiffViewBoundaryProps) {
  const { t } = useLingui();
  const { refresh } = useConflicts();
  const filePath = conflict.file;
  const detectedAt = conflict.detectedAt;
  const [loadedSides, setLoadedSides] = useState<(ConflictSides & { detectedAt: string }) | null>(
    null,
  );
  const sides =
    loadedSides?.file === filePath && loadedSides.detectedAt === detectedAt ? loadedSides : null;
  const [fetchFailed, setFetchFailed] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const hasStrategyFooter =
    sides !== null &&
    (sides.kind === 'delete-modify' ||
      sides.kind === 'modify-delete' ||
      !sides.resolutionOptions.includes('content'));
  const strategyFooterRef = useConflictFooterHeightVar(hasStrategyFooter);

  useEffect(() => {
    console.warn(JSON.stringify({ event: 'editor-area-swap-to-diffview', 'doc.name': docName }));
    return () => {
      console.warn(
        JSON.stringify({ event: 'editor-area-swap-from-diffview', 'doc.name': docName }),
      );
    };
  }, [docName]);

  useEffect(() => {
    let cancelled = false;
    setLoadedSides(null);
    setFetchFailed(false);
    void fetchConflictSides(filePath).then((result) => {
      if (cancelled) return;
      if (result === null || result.file !== filePath) {
        setFetchFailed(true);
      } else {
        setLoadedSides({ ...result, detectedAt });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, detectedAt]);

  function handleResolveResult(
    result: ResolveConflictResult,
    failureMessage: string,
    missingConflictDescription: string = filePath,
    missingConflictSeverity: 'info' | 'warning' = 'info',
  ) {
    if (result.ok) return;
    if (result.reason === 'no-conflict-tracked') {
      refresh();
      const notify = missingConflictSeverity === 'warning' ? toast.warning : toast.info;
      notify(t`No conflict is tracked for this path.`, {
        description: missingConflictDescription,
      });
      return;
    }
    toast.error(failureMessage, { description: result.detail });
  }

  async function handleResolve(content: string) {
    if (sides === null) return;
    const result = await resolveConflictContent(sides.file, content);
    handleResolveResult(
      result,
      t`Couldn't save the resolution for ${filePath}.`,
      t`Someone may have already resolved ${filePath} — check the document's current content before redoing your edit.`,
      'warning',
    );
  }

  async function handleResolveStrategy(dispatch: (file: string) => Promise<ResolveConflictResult>) {
    if (sides === null) return;
    setIsResolving(true);
    const result = await dispatch(sides.file);
    setIsResolving(false);
    handleResolveResult(result, t`Couldn't resolve the conflict for ${filePath}.`);
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

  const offersTheirs = sides.resolutionOptions.includes('theirs');

  if (sides.kind === 'delete-modify') {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="min-h-0 flex-1">
          <ConflictFilePreview filename={filePath} content={sides.theirs} />
        </div>
        <div
          ref={strategyFooterRef}
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
            {offersTheirs && (
              <Button
                type="button"
                variant="default"
                disabled={isResolving}
                onClick={() => void handleResolveStrategy(resolveConflictTheirs)}
              >
                <Trans>Restore with remote changes</Trans>
              </Button>
            )}
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
          ref={strategyFooterRef}
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

  if (!sides.resolutionOptions.includes('content')) {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="min-h-0 flex-1">
          <ConflictFilePreview filename={filePath} content={sides.ours} />
        </div>
        <div
          ref={strategyFooterRef}
          className="flex flex-shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t px-6 py-4"
        >
          <p className="text-sm text-muted-foreground">
            <Trans>
              <span className="font-medium text-foreground">{filePath}</span> can't be merged here.
              Pick the version to keep.
            </Trans>
          </p>
          <div className="flex shrink-0 gap-3">
            {sides.resolutionOptions.includes('mine') && (
              <Button
                type="button"
                variant="default"
                disabled={isResolving}
                onClick={() => void handleResolveStrategy(resolveConflictMine)}
              >
                <Trans>Keep my version</Trans>
              </Button>
            )}
            {offersTheirs && (
              <Button
                type="button"
                variant="default"
                disabled={isResolving}
                onClick={() => void handleResolveStrategy(resolveConflictTheirs)}
              >
                <Trans>Use their version</Trans>
              </Button>
            )}
            {sides.resolutionOptions.includes('delete') && (
              <Button
                type="button"
                variant="destructive"
                disabled={isResolving}
                onClick={() => void handleResolveStrategy(resolveConflictDelete)}
              >
                <Trans>Delete the file</Trans>
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <ConflictView
      fileName={filePath}
      conflictKind={sides.conflictKind}
      ours={sides.ours}
      base={sides.base}
      theirs={sides.theirs}
      onResolve={handleResolve}
    />
  );
}

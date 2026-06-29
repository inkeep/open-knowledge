import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
      }
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
  const { conflicts, loading: conflictsLoading } = useConflicts();
  const conflictEntry = conflicts.find((entry) => filePathToDocName(entry.file) === docName);
  const filePath = conflictEntry?.file ?? `${docName}.md`;
  const [sides, setSides] = useState<ConflictSides | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [isResolving, setIsResolving] = useState(false);

  useEffect(() => {
    console.warn(JSON.stringify({ event: 'editor-area-swap-to-diffview', 'doc.name': docName }));
    return () => {
      console.warn(
        JSON.stringify({ event: 'editor-area-swap-from-diffview', 'doc.name': docName }),
      );
    };
  }, [docName]);

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

  if (sides.kind === 'delete-modify') {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="min-h-0 flex-1">
          <DiffView oldContent="" newContent={sides.theirs} layout="unified" previewMode />
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t px-6 py-4">
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
      <div className="flex h-full flex-col bg-background">
        <div className="min-h-0 flex-1">
          <DiffView oldContent="" newContent={sides.ours} layout="unified" previewMode />
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t px-6 py-4">
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

// oxlint-disable ok/no-physical-direction-utility -- pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md#no-physical-direction-utility

import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConflicts } from '@/hooks/use-conflicts';
import { hashFromDocName, isSameHash } from '@/lib/doc-hash';

function navigateToConflictedDoc(docName: string) {
  const nextHash = hashFromDocName(docName);
  if (typeof window === 'undefined') return;
  if (!isSameHash(window.location.hash, nextHash)) {
    window.location.hash = nextHash;
  }
}

export function ConflictsSection() {
  const { conflicts, loading, error } = useConflicts();
  const { t } = useLingui();

  if (loading) return null;

  if (error === 'server') {
    return (
      <section
        data-testid="conflicts-section"
        aria-label={t`Conflicted files`}
        className="border-b border-warning/30 px-2 py-2"
      >
        <p data-testid="conflicts-section-error" className="px-2 py-1.5 text-[12px] text-warning">
          <AlertTriangle aria-hidden="true" className="mr-1.5 inline size-3" />
          <Trans>Couldn't load conflicts — reload to retry.</Trans>
        </p>
      </section>
    );
  }

  if (conflicts.length === 0) return null;

  return (
    <section
      data-testid="conflicts-section"
      aria-label={t`Conflicted files`}
      className="border-b border-warning/30 px-2 py-2"
    >
      <header className="flex items-center justify-between px-2 pb-1.5">
        <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-warning">
          <AlertTriangle aria-hidden="true" className="size-3" />
          <Trans>Conflicts</Trans>
        </span>
        <span
          data-testid="conflicts-section-count"
          className="rounded-full bg-warning px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none text-background"
        >
          {conflicts.length}
        </span>
      </header>
      <ul className="flex flex-col gap-px">
        {conflicts.map((entry) => {
          const docName = entry.docName;
          return (
            <li key={entry.file}>
              <Button
                variant="ghost"
                size="sm"
                data-testid="conflicts-section-row"
                data-file={entry.file}
                data-conflict-kind={entry.conflictKind}
                data-navigable={docName === null ? 'false' : 'true'}
                disabled={docName === null}
                title={entry.file}
                className="h-auto min-h-7 w-full items-start justify-start gap-1.5 px-2 py-1.5 font-normal text-[13px] text-warning hover:bg-warning/10 hover:text-warning dark:hover:bg-warning/10"
                onClick={() => {
                  if (docName !== null) navigateToConflictedDoc(docName);
                }}
              >
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 text-start">
                  <span className="block truncate">{entry.file}</span>
                  {entry.conflictKind === 'stale-external-write' ? (
                    <span className="block text-pretty text-[11px] leading-4 text-muted-foreground">
                      <Trans>
                        The file was restored to an older version. Open it to choose which version
                        to keep.
                      </Trans>
                    </span>
                  ) : null}
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

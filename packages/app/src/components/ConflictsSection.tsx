// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConflicts } from '@/hooks/use-conflicts';
import { filePathToDocName, hashFromDocName, isSameHash } from '@/lib/doc-hash';

function navigateToConflictedDoc(filePath: string) {
  const docName = filePathToDocName(filePath);
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
        className="border-b border-amber-200/60 bg-amber-50/40 px-2 py-2 dark:border-amber-900/40 dark:bg-amber-950/20"
      >
        <p
          data-testid="conflicts-section-error"
          className="px-2 py-1.5 text-[12px] text-amber-700 dark:text-amber-400"
        >
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
      className="border-b border-amber-200/60 bg-amber-50/40 px-2 py-2 dark:border-amber-900/40 dark:bg-amber-950/20"
    >
      <header className="flex items-center justify-between px-2 pb-1.5">
        <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-amber-700 dark:text-amber-400">
          <AlertTriangle aria-hidden="true" className="size-3" />
          <Trans>Conflicts</Trans>
        </span>
        <span
          data-testid="conflicts-section-count"
          className="rounded-full bg-amber-500 px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none text-white"
        >
          {conflicts.length}
        </span>
      </header>
      <ul className="flex flex-col gap-px">
        {conflicts.map((entry) => (
          <li key={entry.file}>
            <Button
              variant="ghost"
              size="sm"
              data-testid="conflicts-section-row"
              data-file={entry.file}
              title={entry.file}
              className="h-7 w-full justify-start gap-1.5 px-2 font-normal text-[13px] text-amber-800 hover:bg-amber-100/60 hover:text-amber-900 dark:text-amber-300 dark:hover:bg-amber-900/30 dark:hover:text-amber-200"
              onClick={() => navigateToConflictedDoc(entry.file)}
            >
              <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{entry.file}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

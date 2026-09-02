import type { SkillScope, SkillSearchResult } from '@inkeep/open-knowledge-core';
import type { ReactNode } from 'react';
import { SkillDirectoryResult } from '@/components/SkillDirectoryResult';
import { Skeleton } from '@/components/ui/skeleton';
import { useSkillDirectory } from '@/hooks/use-skill-directory';

const SKELETON_KEYS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];

export function SkillDirectoryGrid({
  results,
  pending = false,
  skeletonCount = 8,
  label,
  action,
  loadingLabel,
  scope,
  onNavigate,
  testId,
}: {
  readonly results: readonly SkillSearchResult[];
  readonly pending?: boolean;
  readonly skeletonCount?: number;
  readonly label?: ReactNode;
  readonly action?: ReactNode;
  readonly loadingLabel: string;
  readonly scope?: SkillScope;
  readonly onNavigate?: () => void;
  readonly testId?: string;
}) {
  const { importedEntry, openResult } = useSkillDirectory({ scope, onNavigate });

  return (
    <section className="flex flex-col gap-3" data-testid={testId}>
      {label === undefined ? null : (
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
            {label}
          </h3>
          {action}
        </div>
      )}
      {pending ? (
        <div aria-busy="true">
          <span className="sr-only">{loadingLabel}</span>
          <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" aria-hidden>
            {SKELETON_KEYS.slice(0, skeletonCount).map((k) => (
              <Skeleton key={k} className="h-18 rounded-xl" />
            ))}
          </ul>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {results.map((r) => (
            <SkillDirectoryResult
              key={r.id ?? `${r.source}/${r.name}`}
              result={r}
              imported={importedEntry(r)}
              onOpen={() => openResult(r)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

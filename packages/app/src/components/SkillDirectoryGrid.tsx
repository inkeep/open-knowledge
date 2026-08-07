import type { SkillScope, SkillSearchResult } from '@inkeep/open-knowledge-core';
import type { ReactNode } from 'react';
import { SkillDirectoryResult } from '@/components/SkillDirectoryResult';
import { Skeleton } from '@/components/ui/skeleton';
import { useSkillDirectory } from '@/hooks/use-skill-directory';

// Stable keys for the skeleton set (no array-index keys). Sized to the largest
// grid any caller asks for and sliced down per call.
const SKELETON_KEYS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];

/**
 * A grid of skills.sh-shaped discovery results, with its optional section label
 * and its loading state. Every surface that lists results renders through this —
 * the Explore modal's search / popular / Open Knowledge grids and the Skills
 * home's shelf — so card behavior, column count, and skeleton height stay in
 * lockstep instead of being re-typed per surface.
 *
 * Owns {@link useSkillDirectory}, so a caller supplies the list and the two
 * coordinates a click needs (`scope`, `onNavigate`) and nothing else. `h-18`
 * skeletons match a real row's resting height, so the grid doesn't jump when
 * results land.
 */
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
  /** Section heading; omitted for an unlabeled grid (search results). */
  readonly label?: ReactNode;
  /** Trailing control on the label's row (e.g. "Browse all"). */
  readonly action?: ReactNode;
  /** Screen-reader announcement while `pending` — say what is loading. */
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
              key={r.id}
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

// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ArrowRight,
  BookMarked,
  ChevronDown,
  Compass,
  FileCheck,
  GitBranch,
  Library,
  Loader2,
  Network,
  PenLine,
  StickyNote,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { OkPackId, OkSeedPackInfo } from '@/lib/desktop-bridge-types';
import { seedClient } from '@/lib/seed-client';
import { cn } from '@/lib/utils';

/**
 * Visual icon per pack on the empty-state grid. Hardcoded by pack id rather
 * than threaded through the wire schema — the registry is small and stable,
 * and the icons are presentation-only. A future pack lands here as a new
 * entry; the fallback (`Library`) keeps the card renderable in the meantime.
 */
const PACK_ICONS: Record<OkPackId, React.ComponentType<{ className?: string }>> = {
  'knowledge-base': Library,
  'software-lifecycle': GitBranch,
  'codebase-wiki': BookMarked,
  'plain-notes': StickyNote,
  worldbuilding: Compass,
  'writing-pipeline': PenLine,
  'entity-vault': Network,
  okf: FileCheck,
};

function iconForPack(id: string): React.ComponentType<{ className?: string }> {
  return (PACK_ICONS as Record<string, React.ComponentType<{ className?: string }>>)[id] ?? Library;
}

interface PackCardGridProps {
  /** Invoked when the user clicks a card. Opens the per-pack configurator. */
  onPackSelect: (packId: OkPackId) => void;
  /**
   * When provided, render a subtle "or create a new file" button in the footer
   * row beneath the grid — an escape hatch that starts an empty doc instead of
   * seeding a scaffold. Gated by presence so the modal picker (`SeedDialog`)
   * can omit it: every card there must advance to a per-pack configurator, and
   * a blank file has no configurator step. The empty-state `OnboardingView`
   * passes it.
   */
  onCreateBlankFile?: () => void;
  /**
   * Pack ids to hide behind a "Show more" toggle in the footer row. Collapsed
   * by default; the remaining packs render in registry order and the hidden
   * ones append at the end when expanded. Empty/omitted → every pack shows and
   * no toggle renders (the modal `SeedDialog` path). The empty-state
   * `OnboardingView` passes the secondary packs here.
   */
  collapsedPackIds?: readonly OkPackId[];
  className?: string;
  /**
   * Pre-fetched pack list. When provided, the grid renders from these
   * directly and skips its internal fetch — used by the two-step
   * `SeedDialog` which already owns `packs` state for the downstream
   * configurator. `null` reads as "still loading"; `[]` renders the empty
   * state. Omitted → component self-fetches via `seedClient().listPacks()`
   * (the empty-state canvas usage).
   */
  packs?: OkSeedPackInfo[] | null;
}

/**
 * Pack grid rendered on the empty-state canvas and as step 1 of
 * `SeedDialog`. Each card is a primary action — click advances to the
 * per-pack configurator. Fetches the pack registry on mount (single shared
 * transport with `SeedDialog` via `seedClient`) unless the caller supplied
 * `packs` directly; loading and error states render in-place.
 */
export function PackCardGrid({
  onPackSelect,
  onCreateBlankFile,
  collapsedPackIds,
  className,
  packs: externalPacks,
}: PackCardGridProps) {
  const { t } = useLingui();
  const [internalPacks, setInternalPacks] = useState<OkSeedPackInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const useInternalFetch = externalPacks === undefined;

  useEffect(() => {
    if (!useInternalFetch) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await seedClient().listPacks();
        if (cancelled) return;
        if (result.ok) {
          setInternalPacks(result.packs);
        } else {
          setError(result.error.message);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [useInternalFetch]);

  const packs = useInternalFetch ? internalPacks : externalPacks;

  if (error !== null) {
    return (
      <div
        role="alert"
        className={cn('rounded-md bg-destructive/10 p-4 text-sm text-destructive', className)}
      >
        <Trans>Couldn't load starter packs: {error}</Trans>
      </div>
    );
  }

  if (packs === null) {
    return (
      <div
        role="status"
        className={cn('@container/packgrid w-full max-w-5xl', className)}
        aria-busy="true"
        aria-label={t`Loading starter packs`}
      >
        <div className="grid gap-4 @sm/packgrid:grid-cols-2 @2xl/packgrid:grid-cols-3">
          {Array.from({ length: Object.keys(PACK_ICONS).length }, (_, i) => i).map((i) => (
            <PackCardSkeleton key={`skeleton-${i}`} />
          ))}
        </div>
      </div>
    );
  }

  // Empty packs[] is an unexpected runtime state (the registry ships >= 7
  // packs at build time) but the server-error fallback elsewhere also lands
  // here as `[]` to short-circuit the spinner. Surface a labelled empty
  // state so the user sees something actionable instead of a blank gap.
  if (packs.length === 0) {
    return (
      <div
        role="status"
        className={cn(
          'flex w-full max-w-5xl items-center justify-center rounded-2xl border border-dashed border-border/60 bg-muted/20 p-8 text-sm text-muted-foreground',
          className,
        )}
      >
        <Trans>No starter packs available.</Trans>
      </div>
    );
  }

  // Partition into always-visible packs (registry order) and the ones parked
  // behind "Show more". The hidden set renders in a second grid inside the
  // Collapsible content so it appends after the visible set — same columns +
  // gap keep the seam invisible, reading as "more below" rather than reflowing
  // the existing cards. No collapsedPackIds → hiddenPacks is empty, the
  // Collapsible content/trigger drop out, and every pack shows (the modal
  // `SeedDialog` path).
  const collapsedSet = new Set(collapsedPackIds ?? []);
  const visiblePacks = packs.filter((pack) => !collapsedSet.has(pack.id));
  const hiddenPacks = packs.filter((pack) => collapsedSet.has(pack.id));
  const hasHidden = hiddenPacks.length > 0;
  const showFooter = hasHidden || onCreateBlankFile != null;
  const gridClassName = 'grid gap-4 @sm/packgrid:grid-cols-2 @2xl/packgrid:grid-cols-3';

  return (
    <div className={cn('@container/packgrid w-full max-w-5xl', className)}>
      {/* Controlled Collapsible drives the show-more disclosure: the trigger
          gets aria-expanded + aria-controls and the hidden cards leave the a11y
          tree when collapsed, for free. */}
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className={gridClassName}>
          {visiblePacks.map((pack) => (
            <PackCard key={pack.id} pack={pack} onSelect={() => onPackSelect(pack.id)} />
          ))}
        </div>
        {hasHidden ? (
          // Height + opacity animate via the shared `collapsible-down/up`
          // keyframes (reduced-motion pins height, keeps the crossfade —
          // globals.css). `overflow-hidden` clips the cards during the slide;
          // the inner grid's `pt-4` puts the inter-grid gap INSIDE the measured
          // height so it grows/shrinks with the panel instead of popping in.
          // `-mx-1 px-1 -mb-1 pb-1` widens the clip box by the card focus-ring
          // width (`ring-3`) on the sides + bottom then pulls it back, so a
          // focused card's ring isn't shaved off by `overflow-hidden` (the top
          // already has room via the inner `pt-4`).
          <CollapsibleContent className="-mx-1 -mb-1 overflow-hidden px-1 pb-1 data-[state=open]:animate-[collapsible-down_150ms_ease-out] data-[state=closed]:animate-[collapsible-up_150ms_ease-in]">
            <div className={cn(gridClassName, 'pt-4')}>
              {hiddenPacks.map((pack) => (
                <PackCard key={pack.id} pack={pack} onSelect={() => onPackSelect(pack.id)} />
              ))}
            </div>
          </CollapsibleContent>
        ) : null}
        {showFooter ? (
          // Footer row: the Show more/less toggle (left) + the "create a new
          // file" escape hatch (right). Both are subtle `ghost` buttons so they
          // read as secondary affordances beneath the primary pack cards.
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {hasHidden ? (
              <CollapsibleTrigger asChild>
                <Button type="button" variant="link-muted" size="sm">
                  {expanded ? (
                    <Trans>Show less</Trans>
                  ) : (
                    <Trans>Show {hiddenPacks.length} more</Trans>
                  )}
                  <ChevronDown
                    aria-hidden="true"
                    className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
                  />
                </Button>
              </CollapsibleTrigger>
            ) : (
              <span />
            )}
            {onCreateBlankFile ? (
              <Button type="button" variant="link-muted" size="sm" onClick={onCreateBlankFile}>
                <Trans>
                  or create a new file <ArrowRight aria-hidden="true" className="size-3.5" />
                </Trans>
              </Button>
            ) : null}
          </div>
        ) : null}
      </Collapsible>
    </div>
  );
}

interface PackCardProps {
  pack: OkSeedPackInfo;
  onSelect: () => void;
}

function PackCard({ pack, onSelect }: PackCardProps) {
  const Icon = iconForPack(pack.id);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex h-full min-w-0 flex-col items-start gap-4 rounded-2xl border border-border/60 bg-card p-5 text-left transition-[border-color,box-shadow,transform] hover:border-border hover:shadow-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px"
    >
      <div className="flex w-full min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-row items-start gap-2">
          <span aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground">
            <Icon className="size-3.5" />
          </span>
          <h3 className="min-w-0 wrap-break-word text-sm font-medium leading-tight">{pack.name}</h3>
        </div>

        <p className="line-clamp-2 text-1sm leading-relaxed text-muted-foreground">
          {pack.description}
        </p>
      </div>
    </button>
  );
}

function PackCardSkeleton() {
  return (
    <div className="flex h-full min-h-[200px] flex-col items-start gap-4 rounded-xl border border-border/60 bg-card p-6">
      <span className="size-10 animate-pulse rounded-lg bg-muted" aria-hidden="true">
        <Loader2 className="size-5 animate-spin text-muted-foreground opacity-0" />
      </span>
      <div className="flex w-full flex-col gap-2">
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
      </div>
      <div className="mt-auto h-3 w-20 animate-pulse rounded bg-muted" />
    </div>
  );
}

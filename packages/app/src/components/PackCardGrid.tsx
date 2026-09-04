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
  Network,
  PenLine,
  StickyNote,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { OkPackId, OkSeedPackInfo } from '@/lib/desktop-bridge-types';
import { seedClient } from '@/lib/seed-client';
import { cn } from '@/lib/utils';

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

export function iconForPack(id: string): React.ComponentType<{ className?: string }> {
  return (PACK_ICONS as Record<string, React.ComponentType<{ className?: string }>>)[id] ?? Library;
}

interface PackCardGridProps {
  onPackSelect: (packId: OkPackId) => void;
  onCreateBlankFile?: () => void;
  collapsedPackIds?: readonly OkPackId[];
  className?: string;
  packs?: OkSeedPackInfo[] | null;
}

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

  const collapsedSet = new Set(collapsedPackIds ?? []);
  const visiblePacks = packs.filter((pack) => !collapsedSet.has(pack.id));
  const hiddenPacks = packs.filter((pack) => collapsedSet.has(pack.id));
  const hasHidden = hiddenPacks.length > 0;
  const showFooter = hasHidden || onCreateBlankFile != null;
  const gridClassName = 'grid gap-4 @sm/packgrid:grid-cols-2 @2xl/packgrid:grid-cols-3';

  return (
    <div className={cn('@container/packgrid w-full max-w-5xl', className)}>
      {}
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className={gridClassName}>
          {visiblePacks.map((pack) => (
            <PackCard key={pack.id} pack={pack} onSelect={() => onPackSelect(pack.id)} />
          ))}
        </div>
        {hasHidden ? (
          <CollapsibleContent className="-mx-1 -mb-1 overflow-hidden px-1 pb-1 data-[state=open]:animate-[collapsible-down_150ms_ease-out] data-[state=closed]:animate-[collapsible-up_150ms_ease-in]">
            <div className={cn(gridClassName, 'pt-4')}>
              {hiddenPacks.map((pack) => (
                <PackCard key={pack.id} pack={pack} onSelect={() => onPackSelect(pack.id)} />
              ))}
            </div>
          </CollapsibleContent>
        ) : null}
        {showFooter ? (
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
  const card = (
    <button
      type="button"
      onClick={onSelect}
      data-slot="pack-card"
      className="group relative flex h-full min-w-0 flex-col items-start overflow-hidden rounded-2xl border border-border/60 bg-card p-5 text-left transition-[border-color,box-shadow,transform] hover:border-border hover:shadow-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px"
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

      {}
      <span
        data-slot="pack-card-reveal"
        className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 rounded-[inherit] bg-card/85 text-sm font-medium text-muted-foreground opacity-0 transition-opacity duration-200 ease-out-strong group-hover:opacity-100 group-focus-visible:opacity-100 supports-backdrop-filter:bg-card/35 supports-backdrop-filter:backdrop-blur-md reduced-transparency:bg-card"
      >
        {}
        <span className="inline-flex items-center gap-1.5 motion-safe:translate-y-1 motion-safe:transition-[translate] motion-safe:duration-200 motion-safe:ease-out-strong motion-safe:group-hover:translate-y-0 motion-safe:group-focus-visible:translate-y-0">
          <Trans>See what's added</Trans>
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </span>
      </span>
    </button>
  );

  if (pack.folders.length === 0) return card;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{card}</TooltipTrigger>
      {}
      <TooltipContent className="flex-col items-start gap-1.5">
        <ul className="flex flex-col gap-1.5 text-left">
          {pack.folders.map((folder) => (
            <li key={folder.path} className="flex flex-col">
              <span className="font-mono">{folder.path}</span>
              <span className="opacity-75">{folder.summary}</span>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

function PackCardSkeleton() {
  return (
    <div className="flex h-full min-h-[200px] flex-col items-start gap-4 rounded-xl border border-border/60 bg-card p-6">
      <span className="size-10 animate-pulse rounded-lg bg-muted" aria-hidden="true">
        <Spinner aria-hidden="true" className="size-5 text-muted-foreground opacity-0" />
      </span>
      <div className="flex w-full flex-col gap-2">
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

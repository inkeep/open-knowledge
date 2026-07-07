import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Info } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CopyablePromptList } from '@/components/empty-state/CopyablePromptList';
import { CreatePromptComposer } from '@/components/empty-state/CreatePromptComposer';
import { CreateView } from '@/components/empty-state/CreateView';
import { EmptyStateHeader } from '@/components/empty-state/EmptyStateHeader';
import { getEmptyStateCopy } from '@/components/empty-state/empty-state-copy';
import { filterVisibleEntries } from '@/components/file-tree-utils';
import { PackCardGrid } from '@/components/PackCardGrid';
import { SeedDialog } from '@/components/SeedDialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import { emitCreateTopLevelFile } from '@/lib/create-file-events';
import type { OkPackId } from '@/lib/desktop-bridge-types';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';
import { fetchDocumentListShared } from '@/lib/documents-fetch';
import type { TerminalDockPosition } from '@/lib/terminal-dock-store';
import { cn } from '@/lib/utils';

export function EmptyEditorState({
  terminalDock = null,
}: {
  /** Where the visible terminal is docked, or null when no terminal is open. */
  terminalDock?: TerminalDockPosition | null;
}) {
  const [seedDialogOpen, setSeedDialogOpen] = useState(false);
  const [seedDialogInitialPackId, setSeedDialogInitialPackId] = useState<OkPackId | undefined>(
    undefined,
  );
  const [documentCount, setDocumentCount] = useState<number | null>(null);
  const [celebrateSignal, setCelebrateSignal] = useState(0);
  // Sticky once true — fetch failures after first success keep the prior count.
  const documentCountResolvedRef = useRef(false);
  // Cleared on unmount so a late burst doesn't fire on a stale component.
  const celebrateTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      // Entry count is the sole signal driving the empty-state UX. We
      // count BOTH documents AND folders here because 4 of 5 packs
      // (software-lifecycle, plain-notes, worldbuilding, writing-pipeline)
      // create only folders — counting `kind: 'document'` alone would
      // re-show the onboarding CTA immediately after a successful non-KB
      // seed.
      try {
        const { ok, body } = await fetchDocumentListShared();
        if (cancelled) return;
        const success = ok ? DocumentListSuccessSchema.safeParse(body) : null;
        if (success?.success) {
          setDocumentCount(countEntries(success.data.documents));
          documentCountResolvedRef.current = true;
        } else if (!documentCountResolvedRef.current) {
          // Fallback on initial fetch failure — safer than pitching onboarding blind.
          setDocumentCount(1);
          documentCountResolvedRef.current = true;
        }
      } catch {
        if (!cancelled && !documentCountResolvedRef.current) {
          setDocumentCount(1);
          documentCountResolvedRef.current = true;
        }
      }
    }

    void refresh();
    const unsubscribe = subscribeToDocumentsChanged((channels) => {
      if (channels.includes('files')) void refresh();
    });

    return () => {
      cancelled = true;
      unsubscribe();
      clearTimeout(celebrateTimerRef.current);
    };
  }, []);

  function handleSeedApplied() {
    // Delayed so the dialog close + toast settle before attention shifts to the blob.
    clearTimeout(celebrateTimerRef.current);
    celebrateTimerRef.current = setTimeout(() => setCelebrateSignal((prev) => prev + 1), 500);
    // Apply created docs / scaffolded folders — refetch so the empty-state copy
    // switches branches in sync.
    fetchDocumentListShared()
      .then(({ ok, body }) => {
        if (!ok) return;
        const success = DocumentListSuccessSchema.safeParse(body);
        if (success.success) {
          setDocumentCount(countEntries(success.data.documents));
        }
      })
      .catch(() => {
        /* best-effort — celebration is the priority */
      });
  }

  // Gate the copy until we know which branch to render — avoids flashing the wrong text.
  const messageReady = documentCount !== null;
  const isOnboarding = documentCount === 0;

  function handleDialogOpenChange(next: boolean) {
    setSeedDialogOpen(next);
    // Drop the locked pack once the dialog closes so the next entry point
    // (legacy "Pick a starter pack" CTA on the no-selection branch) doesn't
    // inherit a stale selection.
    if (!next) setSeedDialogInitialPackId(undefined);
  }

  // When the terminal is open (an empty-state CLI launch), keep the header —
  // blob + headline + subtitle, left-aligned in the same column as the full
  // view — but drop the composer bubble + starter-pack list: the terminal is
  // its own AI entry point, so the composer would be a competing dispatch
  // affordance in either dock position. Bottom dock: `justify-end`
  // bottom-anchors the header just above the dock so it rides up/down as the
  // terminal is resized (matching the prior blob-only pose). Right dock keeps
  // its vertical space, so the header centers instead.
  if (terminalDock !== null) {
    return (
      // `@container/emptystate` scopes the child media queries to the editor
      // pane's own width, not the window's — a narrow split-view pane gets the
      // narrow layout even on a wide monitor. The padding + blob-stacking below
      // key off `@md/emptystate:` for that reason.
      <div
        className={cn(
          '@container/emptystate flex min-h-0 flex-1 flex-col items-center pb-8 pt-10',
          terminalDock === 'bottom' ? 'justify-end' : 'justify-center',
        )}
      >
        <div className="flex w-full flex-col items-center px-4 @md/emptystate:px-10 @2xl/emptystate:px-16">
          {messageReady ? (
            <TerminalEmptyHeader isOnboarding={isOnboarding} celebrateSignal={celebrateSignal} />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    // See the terminal branch above for why this is an `@container/emptystate`:
    // padding + header layout respond to the pane width, not the viewport.
    <div className="@container/emptystate flex min-h-0 flex-1 flex-col items-center overflow-y-auto subtle-scrollbar">
      <div className="flex w-full flex-1 flex-col items-center px-4 @md/emptystate:px-10 @2xl/emptystate:px-16">
        {messageReady ? (
          isOnboarding ? (
            <OnboardingView
              celebrateSignal={celebrateSignal}
              onPackSelect={(packId) => {
                setSeedDialogInitialPackId(packId);
                setSeedDialogOpen(true);
              }}
            />
          ) : (
            <CreateView
              celebrateSignal={celebrateSignal}
              onAddStarterPack={() => {
                // No `initialPackId` — lands at step 1 (PackCardGrid) so the
                // user picks a pack inside the dialog rather than the canvas.
                setSeedDialogOpen(true);
              }}
            />
          )
        ) : null}
        <SeedDialog
          open={seedDialogOpen}
          onOpenChange={handleDialogOpenChange}
          onSeedApplied={handleSeedApplied}
          initialPackId={seedDialogInitialPackId}
        />
      </div>
    </div>
  );
}

/**
 * Counts user-visible content entries for the onboarding gate. Exported for
 * unit-testing the hidden-file filter independently of the React tree.
 */
export function countEntries(
  entries: ReadonlyArray<{ kind?: unknown; docName?: string; path?: string }>,
): number {
  // Count BOTH documents AND folders — most starter packs (4 of 5) create
  // only folders, no top-level documents. Counting documents alone would
  // re-trigger the onboarding CTA immediately after a successful non-KB
  // seed.
  //
  // Hidden-file filter (core `isHiddenDocName`: the per-segment dot-prefix
  // rule plus the `HIDDEN_CONFIG_BASENAMES` basename allowlist) lives in
  // `filterVisibleEntries` — single source of truth shared with the
  // sidebar FileTree ingestion. `.git/` and `.ok/` are already pruned
  // server-side by `BUILTIN_SKIP_DIRS`; the shared filter handles
  // user-authored hidden folders like `.private/` or `.archive/` plus
  // non-dotted agent configs like `opencode.json`.
  return filterVisibleEntries(entries).filter(
    (entry) => entry.kind === 'document' || entry.kind === 'folder',
  ).length;
}

/**
 * Header-only empty state shown while a terminal is open (either dock). Shares the
 * onboarding/create copy with the full-height views via `getEmptyStateCopy`,
 * but omits the composer + starter packs that would crowd the terminal below.
 * Left-aligned within the shared `max-w-5xl` column; the parent bottom-anchors it.
 */
function TerminalEmptyHeader({
  isOnboarding,
  celebrateSignal,
}: {
  isOnboarding: boolean;
  celebrateSignal: number;
}) {
  const { t } = useLingui();
  const isEmbedded = useIsEmbedded();
  const { title, subtitle } = getEmptyStateCopy({ isOnboarding, isEmbedded });
  return (
    <div className="w-full max-w-5xl">
      <EmptyStateHeader title={t(title)} subtitle={t(subtitle)} celebrateSignal={celebrateSignal} />
    </div>
  );
}

function OnboardingView({
  celebrateSignal,
  onPackSelect,
}: {
  celebrateSignal: number;
  onPackSelect: (packId: OkPackId) => void;
}) {
  const { t } = useLingui();
  const isEmbedded = useIsEmbedded();
  const { title, subtitle } = getEmptyStateCopy({ isOnboarding: true, isEmbedded });
  return (
    <div className="flex w-full flex-col gap-10 py-12 max-w-5xl my-auto">
      <EmptyStateHeader title={t(title)} subtitle={t(subtitle)} celebrateSignal={celebrateSignal} />
      {/* AI surface up top — the primary path. Non-embedded: compose a brief and
          hand off to a coding agent. Embedded (OK inside Cursor/Codex/Claude):
          show the same starter prompts as copy-to-paste rows, since the launch
          handoff would loop back. `new-project`: brand-new project. */}
      {isEmbedded ? (
        <CopyablePromptList scenario="new-project" />
      ) : (
        <CreatePromptComposer scenario="new-project" />
      )}
      {/* Group the divider + grid + escape hatch in their own tight container
          so the link sits close beneath the cards while the header/composer
          above keep the parent's wider `gap-10` breathing room. */}
      <div className="flex w-full flex-col gap-3">
        <TemplateDivider label={isEmbedded ? t`Use a starter pack` : t`Or use a starter pack`} />
        {/* Non-modal grid: keep the primary packs visible and park the
            secondary ones (`okf`, `entity-vault`) behind "Show more". The
            "or create a new file" footer button is the escape hatch for users
            who don't want a scaffolded layout — it fires the same window-level
            event the sidebar toolbar uses, so the new file lands with the
            standard inline-rename flow (sidebar handles focus + navigation). */}
        <PackCardGrid
          onPackSelect={onPackSelect}
          onCreateBlankFile={() => emitCreateTopLevelFile()}
          collapsedPackIds={['okf', 'entity-vault']}
        />
      </div>
    </div>
  );
}

/** Labeled section header above the starter-pack grid ("Or use a starter
 *  pack") plus an info tooltip explaining what a starter pack is. */
function TemplateDivider({ label }: { label: string }) {
  const { t } = useLingui();
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground whitespace-nowrap">
        {label}
      </span>
      <Tooltip>
        <TooltipTrigger
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label={t`What is a starter pack?`}
          data-testid="starter-pack-info"
        >
          <Info className="size-3.5" aria-hidden />
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="leading-relaxed wrap-break-word">
            <Trans>
              Ready-made folders and templates to get you started quickly. Select a pack to preview
              what gets created, then add it to your project.
            </Trans>
          </p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

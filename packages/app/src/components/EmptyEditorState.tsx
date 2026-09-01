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
import { cn } from '@/lib/utils';

export function EmptyEditorState({
  terminalOpen = false,
  agentsOpen = false,
  onRageStreak,
}: {
  terminalOpen?: boolean;
  agentsOpen?: boolean;
  onRageStreak?: () => void;
}) {
  const [seedDialogOpen, setSeedDialogOpen] = useState(false);
  const [seedDialogInitialPackId, setSeedDialogInitialPackId] = useState<OkPackId | undefined>(
    undefined,
  );
  const [documentCount, setDocumentCount] = useState<number | null>(null);
  const [celebrateSignal, setCelebrateSignal] = useState(0);
  const documentCountResolvedRef = useRef(false);
  const celebrateTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const { ok, body } = await fetchDocumentListShared();
        if (cancelled) return;
        const success = ok ? DocumentListSuccessSchema.safeParse(body) : null;
        if (success?.success) {
          setDocumentCount(countEntries(success.data.documents));
          documentCountResolvedRef.current = true;
        } else if (!documentCountResolvedRef.current) {
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
    clearTimeout(celebrateTimerRef.current);
    celebrateTimerRef.current = setTimeout(() => setCelebrateSignal((prev) => prev + 1), 500);
    fetchDocumentListShared()
      .then(({ ok, body }) => {
        if (!ok) return;
        const success = DocumentListSuccessSchema.safeParse(body);
        if (success.success) {
          setDocumentCount(countEntries(success.data.documents));
        }
      })
      .catch(() => {});
  }

  const messageReady = documentCount !== null;
  const isOnboarding = documentCount === 0;

  function handleDialogOpenChange(next: boolean) {
    setSeedDialogOpen(next);
    if (!next) setSeedDialogInitialPackId(undefined);
  }

  if (terminalOpen || agentsOpen) {
    return (
      <div
        data-testid="empty-editor-state"
        className={cn(
          '@container/emptystate flex min-h-0 flex-1 flex-col items-center pb-8 pt-10',
          terminalOpen ? 'justify-end' : 'justify-center',
        )}
      >
        <div className="flex w-full flex-col items-center px-4 @md/emptystate:px-10 @2xl/emptystate:px-16">
          {messageReady ? (
            <TerminalEmptyHeader
              isOnboarding={isOnboarding}
              celebrateSignal={celebrateSignal}
              onRageStreak={onRageStreak}
            />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="empty-editor-state"
      className="@container/emptystate flex min-h-0 flex-1 flex-col items-center overflow-y-auto subtle-scrollbar"
    >
      <div className="flex w-full flex-1 flex-col items-center px-4 @md/emptystate:px-10 @2xl/emptystate:px-16">
        {messageReady ? (
          isOnboarding ? (
            <OnboardingView
              onRageStreak={onRageStreak}
              celebrateSignal={celebrateSignal}
              onPackSelect={(packId) => {
                setSeedDialogInitialPackId(packId);
                setSeedDialogOpen(true);
              }}
            />
          ) : (
            <CreateView
              onRageStreak={onRageStreak}
              celebrateSignal={celebrateSignal}
              onAddStarterPack={() => {
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

export function countEntries(
  entries: ReadonlyArray<{ kind?: unknown; docName?: string; path?: string }>,
): number {
  return filterVisibleEntries(entries).filter(
    (entry) => entry.kind === 'document' || entry.kind === 'folder',
  ).length;
}

function TerminalEmptyHeader({
  isOnboarding,
  celebrateSignal,
  onRageStreak,
}: {
  isOnboarding: boolean;
  celebrateSignal: number;
  onRageStreak?: () => void;
}) {
  const { t } = useLingui();
  const isEmbedded = useIsEmbedded();
  const { title, subtitle } = getEmptyStateCopy({ isOnboarding, isEmbedded });
  return (
    <div className="w-full max-w-5xl">
      <EmptyStateHeader
        title={t(title)}
        subtitle={t(subtitle)}
        celebrateSignal={celebrateSignal}
        onRageStreak={onRageStreak}
      />
    </div>
  );
}

function OnboardingView({
  celebrateSignal,
  onPackSelect,
  onRageStreak,
}: {
  celebrateSignal: number;
  onPackSelect: (packId: OkPackId) => void;
  onRageStreak?: () => void;
}) {
  const { t } = useLingui();
  const isEmbedded = useIsEmbedded();
  const { title, subtitle } = getEmptyStateCopy({ isOnboarding: true, isEmbedded });
  return (
    <div className="flex w-full flex-col gap-10 py-12 max-w-5xl my-auto">
      <EmptyStateHeader
        title={t(title)}
        subtitle={t(subtitle)}
        celebrateSignal={celebrateSignal}
        onRageStreak={onRageStreak}
      />
      {}
      {isEmbedded ? (
        <CopyablePromptList scenario="new-project" />
      ) : (
        <CreatePromptComposer scenario="new-project" />
      )}
      {}
      <div className="flex w-full flex-col gap-3">
        <TemplateDivider label={isEmbedded ? t`Use a starter pack` : t`Or use a starter pack`} />
        {}
        <PackCardGrid
          onPackSelect={onPackSelect}
          onCreateBlankFile={() => emitCreateTopLevelFile()}
          collapsedPackIds={['okf', 'entity-vault']}
        />
      </div>
    </div>
  );
}

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

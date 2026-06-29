import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { CopyablePromptList } from '@/components/empty-state/CopyablePromptList';
import { CreatePromptComposer } from '@/components/empty-state/CreatePromptComposer';
import { CreateView } from '@/components/empty-state/CreateView';
import { EmptyStateHeader } from '@/components/empty-state/EmptyStateHeader';
import { getEmptyStateCopy } from '@/components/empty-state/empty-state-copy';
import { filterVisibleEntries } from '@/components/file-tree-utils';
import { PackCardGrid } from '@/components/PackCardGrid';
import { SeedDialog } from '@/components/SeedDialog';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import { emitCreateTopLevelFile } from '@/lib/create-file-events';
import type { OkPackId } from '@/lib/desktop-bridge-types';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';

export function EmptyEditorState({ terminalVisible = false }: { terminalVisible?: boolean }) {
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
        const res = await fetch('/api/documents');
        const body = (await res.json().catch(() => null)) as unknown;
        if (cancelled) return;
        const success = res.ok ? DocumentListSuccessSchema.safeParse(body) : null;
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
    fetch('/api/documents')
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as unknown;
        if (!res.ok) return;
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

  if (terminalVisible) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-end px-6 sm:px-12 md:px-16 pb-8 pt-10">
        {messageReady ? (
          <TerminalEmptyHeader isOnboarding={isOnboarding} celebrateSignal={celebrateSignal} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 sm:px-12 md:px-16 subtle-scrollbar">
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
      <div className="flex w-full flex-col gap-4">
        <TemplateDivider label={isEmbedded ? t`Use a starter pack` : t`Or use a starter pack`} />
        {/* The trailing "Blank file" card is the escape hatch for users who
            don't want a scaffolded layout — it fires the same window-level
            event the sidebar toolbar uses, so the new file lands with the
            standard inline-rename flow (sidebar handles focus + navigation). */}
        <PackCardGrid
          onPackSelect={onPackSelect}
          onCreateBlankFile={() => emitCreateTopLevelFile()}
        />
      </div>
    </div>
  );
}

/** Labeled hairline rule above the starter-pack grid ("Or start from a
 *  template"). Mirrors the screenshot's section divider. */
function TemplateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground whitespace-nowrap">
        {label}
      </span>
    </div>
  );
}

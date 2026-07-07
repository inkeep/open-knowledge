import type { TemplatesListEntry } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowRightIcon, Plus } from 'lucide-react';
import { CopyablePromptList } from '@/components/empty-state/CopyablePromptList';
import { CreatePromptComposer } from '@/components/empty-state/CreatePromptComposer';
import { EmptyStateHeader } from '@/components/empty-state/EmptyStateHeader';
import { getEmptyStateCopy } from '@/components/empty-state/empty-state-copy';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAllTemplates } from '@/hooks/use-folder-config';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import { emitCreateTopLevelFile } from '@/lib/create-file-events';

interface CreateViewProps {
  /** Bumped to replay the OkBlob celebrate burst (post-seed). */
  readonly celebrateSignal: number;
  /** Open the SeedDialog at step 1 (PackCardGrid) from the bottom strip. */
  readonly onAddStarterPack: () => void;
}

/**
 * Post-init empty-state view (project has content, no doc open). Three
 * non-obvious behaviors worth flagging:
 *   - New files always create at root (the "or create a new file" link, like
 *     the sidebar `+`). Sticky last-folder tracking was tried and reverted
 *     (two sources of truth with the sidebar `+`).
 *   - Template rows create in each template's `source_folder` — keeps
 *     this surface consistent with `write({ template })`.
 *   - The AI surface sits at the top: `CreatePromptComposer` normally, or
 *     `CopyablePromptList` (copy-to-paste prompts) when OK runs inside
 *     Cursor/Codex/Claude, where the launch handoff would loop back to the host.
 */
export function CreateView({ celebrateSignal, onAddStarterPack }: CreateViewProps) {
  const { t } = useLingui();
  const isEmbedded = useIsEmbedded();
  const { title, subtitle } = getEmptyStateCopy({ isOnboarding: false, isEmbedded });
  const templatesState = useAllTemplates();
  const initialDir = '';

  const templates = templatesState.status === 'ready' ? templatesState.data : [];
  const templatesLoading = templatesState.status === 'loading' || templatesState.status === 'idle';
  const templatesError = templatesState.status === 'error';

  return (
    <div className="flex w-full flex-col gap-8 py-12 max-w-5xl my-auto">
      <EmptyStateHeader title={t(title)} subtitle={t(subtitle)} celebrateSignal={celebrateSignal} />

      {/* AI surface up top — the primary path. Non-embedded: compose a brief and
          hand off to a coding agent. Embedded (OK inside Cursor/Codex/Claude):
          the handoff would loop back, so show the same starter prompts as
          copy-to-paste rows instead. `existing-repo`: project already has
          content, so prompts pitch spec / architecture work. */}
      {isEmbedded ? (
        <CopyablePromptList scenario="existing-repo" />
      ) : (
        <CreatePromptComposer scenario="existing-repo" />
      )}

      <div className="flex w-full flex-col gap-8">
        {templatesLoading || templatesError || templates.length > 0 ? (
          <TemplatesSection
            templates={templates}
            loading={templatesLoading}
            error={templatesError}
            onSelect={(folder, name) => emitCreateTopLevelFile({ template: { folder, name } })}
          />
        ) : null}

        {/* Sit the footer links close under the block above — the templates
            card, or the composer when there are no templates — rather than a
            full gap-8/gap-10 away. */}
        <div className="-mt-6 flex w-full items-center justify-between gap-4">
          <Button
            onClick={onAddStarterPack}
            variant="link-muted"
            size="xs"
            className="font-mono text-xs uppercase tracking-wider"
          >
            <Plus aria-hidden="true" className="size-3" />
            <Trans>Add a starter pack</Trans>
          </Button>
          {/* Escape hatch — fires the same window-level event the sidebar
              toolbar uses, so the new file lands with the standard inline-rename
              flow. Mirrors OnboardingView's "or create a new file" link. */}
          <Button
            variant="link-muted"
            className="justify-end"
            size="sm"
            onClick={() => emitCreateTopLevelFile({ initialDir })}
          >
            <Trans>
              or create a new file <ArrowRightIcon aria-hidden="true" className="size-3" />
            </Trans>
          </Button>
        </div>
      </div>
    </div>
  );
}

interface TemplatesSectionProps {
  readonly templates: readonly TemplatesListEntry[];
  readonly loading: boolean;
  readonly error: boolean;
  readonly onSelect: (folder: string, name: string) => void;
}

function TemplatesSection({ templates, loading, error, onSelect }: TemplatesSectionProps) {
  const { t } = useLingui();
  return (
    <section aria-label={t`From template`} className="flex w-full flex-col gap-3">
      <header className="flex items-center gap-2 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
        <span>
          <Trans>From template</Trans>
        </span>
        {loading || error ? null : (
          <Badge
            className="text-2xs"
            variant="gray"
            aria-label={t`${templates.length} templates available`}
          >
            {templates.length}
          </Badge>
        )}
      </header>
      {/* Cap the height so the footer stays in the viewport regardless of
          template count. */}
      <div className="w-full overflow-hidden rounded-xl border border-border/60 bg-card">
        <section
          aria-busy={loading}
          aria-label={t`Template list`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable scroll region per WCAG 2.1.1 (keyboard-operable)
          tabIndex={0}
          className="subtle-scrollbar scroll-fade-mask flex max-h-[260px] w-full flex-col overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {loading ? (
            <p className="p-4 text-1sm text-muted-foreground">
              <Trans>Loading templates</Trans>
            </p>
          ) : error ? (
            <p role="alert" className="p-4 text-1sm text-destructive">
              <Trans>Could not load templates. Try again later.</Trans>
            </p>
          ) : (
            templates.map((tpl) => {
              const targetLabel = tpl.source_folder === '' ? '/' : `${tpl.source_folder}/`;
              return (
                <TemplateRow
                  key={`${tpl.source_folder}/${tpl.name}`}
                  template={tpl}
                  targetLabel={targetLabel}
                  onClick={() => onSelect(tpl.source_folder, tpl.name)}
                />
              );
            })
          )}
        </section>
      </div>
    </section>
  );
}

interface TemplateRowProps {
  readonly template: TemplatesListEntry;
  readonly targetLabel: string;
  readonly onClick: () => void;
}

function TemplateRow({ template, targetLabel, onClick }: TemplateRowProps) {
  const { t } = useLingui();
  const displayTitle = template.title?.trim() || template.name;
  const fileName = `${template.name}.md`;
  const targetIsRoot = template.source_folder === '';
  // Explicit aria-label — the default computed name concatenates the spans
  // into a run-on string ("Meeting Notesmeeting-notes.mdmeetings/").
  const accessibleName = targetIsRoot
    ? t`New file from template "${displayTitle}" (${fileName}) in the project root`
    : t`New file from template "${displayTitle}" (${fileName}) in ${targetLabel}`;
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      aria-label={accessibleName}
      className="group flex h-auto w-full items-center justify-between gap-4 rounded-none p-4 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-sm font-medium leading-tight text-foreground/80">
          {displayTitle}
        </span>
        <span className="truncate font-mono text-1sm font-normal text-muted-foreground">
          {fileName}
        </span>
      </span>
      <span
        className={`shrink-0 font-mono text-1sm ${
          targetIsRoot ? 'text-muted-foreground/70' : 'text-muted-foreground'
        }`}
      >
        {targetLabel}
      </span>
    </Button>
  );
}

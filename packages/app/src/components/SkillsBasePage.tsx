import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowRight, Compass, FilePlus2, Upload } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { CreatePromptComposer } from '@/components/empty-state/CreatePromptComposer';
import { EmptyStateHeader } from '@/components/empty-state/EmptyStateHeader';
import type { AddSkillTab } from '@/components/ImportSkillDialog';
import { SkillDirectoryGrid } from '@/components/SkillDirectoryGrid';
import { Button } from '@/components/ui/button';
import { useCreateBlankSkill } from '@/hooks/use-create-blank-skill';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { usePopularSkills } from '@/hooks/use-popular-skills';

// Lazy so the add-skill modal (skills.sh search, upload, and the new-skill form
// + their skills-api) stays out of the base-page bundle — it loads on first open.
const ImportSkillDialog = lazy(() =>
  import('@/components/ImportSkillDialog').then((m) => ({ default: m.ImportSkillDialog })),
);

/** How many popular skills the home shows before "Browse all" takes over. Three
 *  rows of two at full width; `/api/skills/popular` returns more than this. */
const POPULAR_LIMIT = 6;

interface SkillsBasePageProps {
  /** Whether the sessions dock (in-app agent thread, agent CLI, or bare shell) is
   *  open. `EditorArea` derives it from the same `terminalVisible` flag that gates
   *  `EmptyEditorState`'s composer — the name is legacy, the flag covers all three
   *  session kinds. */
  readonly sessionsDockOpen?: boolean;
}

/**
 * The Skills destination — the full-pane view behind the synthetic `skills` tab
 * kind (see `navigation-targets`). Reads top-down as one decision: describe the
 * skill you want and an agent authors it (the shared `CreatePromptComposer` with
 * the `skill` scenario, which hands off via the built-in
 * `open-knowledge-write-skill` skill), or bring one you already have — Upload
 * and New from scratch sit directly under the input as quiet text actions.
 *
 * Below that, the top skills.sh skills render through the SAME
 * `SkillDirectoryResult` card the Explore modal uses, so a skill looks and
 * behaves identically here and there: clicking one opens its read-only preview
 * (where Install lives), and one already in the project shows "Added" and opens
 * its real doc.
 *
 * Two things remove the composer: `useIsEmbedded` (inside a host agent the handoff
 * would loop back) and an open sessions dock (the agent thread or CLI in it is
 * already a dispatch affordance, so a second one competes with it — the same
 * reason `EmptyEditorState` drops its composer for a docked terminal). Nothing
 * else changes in either case; the add actions below keep their quiet treatment
 * so the row looks the same everywhere.
 *
 * The installed skills themselves live in the sidebar Skills navigator.
 */
export function SkillsBasePage({ sessionsDockOpen = false }: SkillsBasePageProps) {
  const { t } = useLingui();
  const isEmbedded = useIsEmbedded();
  const composerHidden = isEmbedded || sessionsDockOpen;

  // Which add-skill tab the modal opens on; `null` means closed. Tracking the
  // tab (not a bare boolean) lets each entry point deep-link into its pane, and
  // because the modal unmounts when closed, every open remounts Radix Tabs with
  // the right `defaultValue`.
  const [addTab, setAddTab] = useState<AddSkillTab | null>(null);

  const openSkill = useOpenSkill();
  const { createBlank } = useCreateBlankSkill();

  // Shared with the Explore modal's blank state, so opening the modal over this
  // page reuses the cached list instead of refetching.
  const { skills: allPopular, isPending: popularPending } = usePopularSkills();
  const popular = allPopular.slice(0, POPULAR_LIMIT);
  // A failed or empty upstream list hides the shelf rather than stranding a
  // header over nothing. `Browse skills.sh` below is deliberately outside this
  // section, so an outage never removes the path into the directory.
  const showPopular = popularPending || popular.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col items-center overflow-auto subtle-scrollbar p-10">
      <div className="my-auto w-full max-w-4xl space-y-6">
        {/* Reuse the home page's modular header (Blobby + title/subtitle) so the
            Skills home reads as the same surface, not a bespoke one. The subtitle
            folds in the day-zero value prop — someone landing here with skills
            already in their editors needs to know what OK adds — so it sits with
            the pitch instead of a disconnected footer line. */}
        <EmptyStateHeader
          title={t`Create a skill.`}
          subtitle={t`Describe what it should do, or add one yourself. OpenKnowledge keeps your skills in one place, versions them, and installs them into agents like Claude, Codex, and Cursor.`}
          celebrateSignal={0}
        />

        <div className="flex flex-col gap-2">
          {composerHidden ? null : <CreatePromptComposer scenario="skill" />}

          {/* The non-AI paths, deliberately quiet in every state: they're
              alternatives to the composer, not competing calls to action, so they
              read as text actions rather than the cards they replaced. They stay
              quiet even with the composer hidden — a weighted button here would
              compete with whatever replaced it (an open agent thread), and one
              promoted button beside two ghosts reads as inconsistency rather than
              hierarchy at this size and spacing. */}
          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAddTab('upload')}
              data-testid="skill-source-upload"
              className="gap-1.5 font-normal text-muted-foreground hover:text-foreground"
            >
              <Upload aria-hidden="true" className="size-3.5" />
              <Trans>Upload a skill</Trans>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void createBlank('project')}
              data-testid="skill-source-new"
              className="gap-1.5 font-normal text-muted-foreground hover:text-foreground"
            >
              <FilePlus2 aria-hidden="true" className="size-3.5" />
              <Trans>New from scratch</Trans>
            </Button>
            {/* Lives here rather than only in the shelf header below so a
                skills.sh outage — which hides the shelf — never takes the
                page's path into the directory with it. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAddTab('skills-sh')}
              data-testid="skill-source-skills-sh"
              className="gap-1.5 font-normal text-muted-foreground hover:text-foreground"
            >
              <Compass aria-hidden="true" className="size-3.5" />
              <Trans>Browse skills.sh</Trans>
            </Button>
          </div>
        </div>

        {showPopular ? (
          <SkillDirectoryGrid
            scope="project"
            results={popular}
            pending={popularPending}
            skeletonCount={POPULAR_LIMIT}
            testId="skills-popular"
            loadingLabel={t`Loading popular skills`}
            label={<Trans>Popular on skills.sh</Trans>}
            // Browse all renders only once the cards do: it is the one focusable
            // control inside a section that disappears on a failed fetch, and a
            // keyboard user sitting on it while that landed would have focus
            // dropped to the body. The label holds the row's height either way.
            action={
              popularPending ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setAddTab('skills-sh')}
                  data-testid="skill-popular-browse-all"
                  className="h-auto gap-1 py-0.5 font-mono text-2xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
                >
                  <Trans>Browse all</Trans>
                  <ArrowRight aria-hidden="true" className="size-3" />
                </Button>
              )
            }
          />
        ) : null}
      </div>

      {addTab !== null ? (
        <Suspense fallback={null}>
          <ImportSkillDialog
            defaultScope="project"
            defaultTab={addTab}
            open
            onOpenChange={(open) => {
              if (!open) setAddTab(null);
            }}
            onImported={({ scope, name }) => {
              setAddTab(null);
              openSkill(scope, name);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

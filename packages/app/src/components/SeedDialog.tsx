import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CreatedItemsList } from '@/components/CreatedItemsList';
import { PackCardGrid } from '@/components/PackCardGrid';
import { Button } from '@/components/ui/button';
import {
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  Dialog as DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { OkPackId, OkScaffoldPlan, OkSeedPackInfo } from '@/lib/desktop-bridge-types';
import { seedClient } from '@/lib/seed-client';

const DEFAULT_PACK_ID: OkPackId = 'knowledge-base';

interface SeedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after a successful apply — used by the empty state to trigger the
      OkBlob celebration burst. The dialog still owns the toast + dismissal. */
  onSeedApplied?: () => void;
  /**
   * Pre-selects a pack and hides the in-dialog pack picker. When set, the
   * dialog acts as a per-pack configurator (templates + root + preview) for
   * callers that already chose the pack on a parent surface (e.g. the empty-
   * state `PackCardGrid`). Unset → the dialog renders the legacy picker.
   */
  initialPackId?: OkPackId;
}

type DialogPhase =
  | { kind: 'loading' }
  | { kind: 'plan'; plan: OkScaffoldPlan }
  | { kind: 'already-seeded'; plan: OkScaffoldPlan }
  | { kind: 'error'; message: string }
  | { kind: 'applying'; plan: OkScaffoldPlan };

type RootChoice = 'project-root' | 'subfolder';
type DialogStep = 'pick' | 'configure';

/**
 * Multi-pack starter dialog with two steps:
 *   Step 1 ('pick') — `PackCardGrid` (same surface as the empty-state canvas);
 *     skipped when the caller passes `initialPackId` (entry from the canvas
 *     grid already picked the pack).
 *   Step 2 ('configure') — root chooser, live plan preview, Initialize action.
 *     A Back affordance returns to step 1 when the dialog opened there.
 *
 * Mirrors the CLI flow: list packs → pick pack → fetch plan → confirm → apply.
 * Title is "Initialize" — the multi-pack identity isn't bound to a single
 * pack's name.
 *
 * Runs in both desktop (via IPC) and web (via HTTP) distributions.
 */
export function SeedDialog({ open, onOpenChange, onSeedApplied, initialPackId }: SeedDialogProps) {
  const { t } = useLingui();
  const [phase, setPhase] = useState<DialogPhase>({ kind: 'loading' });
  const [packs, setPacks] = useState<OkSeedPackInfo[] | null>(null);
  const [selectedPackId, setSelectedPackId] = useState<OkPackId>(initialPackId ?? DEFAULT_PACK_ID);
  const [rootChoice, setRootChoice] = useState<RootChoice>('project-root');
  const [subfolder, setSubfolder] = useState<string>('');
  // Tracks which step the body is rendering. Starts at 'configure' when the
  // caller pre-picked a pack (canvas entry); otherwise the user picks in
  // step 1 first. Reset on open so reopening always honors current props.
  const [step, setStep] = useState<DialogStep>(initialPackId !== undefined ? 'configure' : 'pick');
  // Tracks whether the next re-plan is the first one this open cycle. The
  // first one fires immediately so the dialog renders without a 200ms delay;
  // subsequent runs (driven by typing) keep the debounce. Reset on open.
  const isFirstLoadRef = useRef(true);

  // React Compiler is enabled; manual memoization is forbidden — derive directly.
  const selectedPack = packs?.find((p) => p.id === selectedPackId);

  // Fetch pack list once on first open; cache for the dialog's lifetime.
  // On failure, surface the error AND clear the loading spinner so they
  // don't render simultaneously — the planning effect short-circuits on
  // `packs === null` and would otherwise hold the spinner forever.
  useEffect(() => {
    if (!open || packs !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await seedClient().listPacks();
        if (cancelled) return;
        if (result.ok) {
          setPacks(result.packs);
        } else {
          setPacks([]); // empty list short-circuits the planning loading state
          setPhase({ kind: 'error', message: result.error.message });
        }
      } catch (err) {
        if (cancelled) return;
        setPacks([]);
        setPhase({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, packs]);

  // Reset form whenever the dialog opens so users get a predictable starting
  // state (rather than stale values from a previous cancel). When the caller
  // passed an `initialPackId` (canvas-grid entry path), honor it instead of
  // falling back to the default — otherwise users would click a specific
  // pack card and land on the KB defaults. Step also resets: callers with a
  // pre-picked pack skip step 1, everyone else starts at the grid.
  useEffect(() => {
    if (open) {
      setSelectedPackId(initialPackId ?? DEFAULT_PACK_ID);
      setRootChoice('project-root');
      setSubfolder('');
      setStep(initialPackId !== undefined ? 'configure' : 'pick');
      setPhase({ kind: 'loading' });
      isFirstLoadRef.current = true;
    }
  }, [open, initialPackId]);

  // When a pack is selected, sync the subfolder field with its default. Packs
  // with a `defaultSubfolder` pre-fill; packs without one (e.g. plain-notes)
  // clear the field so switching from `brain/` → no-default doesn't leave a
  // stale value behind.
  useEffect(() => {
    if (!selectedPack) return;
    setSubfolder(selectedPack.defaultSubfolder ?? '');
  }, [selectedPack]);

  // Whitespace-only subfolder while the "subfolder" radio is selected is a
  // form error — surface it inline and gate Initialize. Computed once per
  // render so both the effect and the JSX read the same source of truth.
  const trimmedSubfolder = subfolder.trim();
  const subfolderInvalid = rootChoice === 'subfolder' && trimmedSubfolder === '';

  // Re-plan whenever selection changes. The first run after open fires
  // immediately; subsequent runs (driven by typing in the subfolder field)
  // get a 200ms debounce. The loading flip happens INSIDE the timer so
  // typing doesn't strobe "Computing scaffold plan…" between keystrokes.
  // Gated on step 'configure' — step 1 doesn't render the preview, so
  // planning there burns a fetch the user never sees and would flash
  // stale state if they navigate back-then-forward to a different pack.
  useEffect(() => {
    if (!open) return;
    if (step !== 'configure') return;
    if (packs === null) return; // wait for pack list before planning

    if (subfolderInvalid) {
      setPhase({ kind: 'error', message: t`Enter a folder name (e.g. brain).` });
      return;
    }

    const effectiveRoot = rootChoice === 'project-root' ? undefined : trimmedSubfolder;
    const delay = isFirstLoadRef.current ? 0 : 200;
    isFirstLoadRef.current = false;

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      // Only flip to a loading visual if no plan is already on screen — keeps
      // the live preview smooth when the user is still typing.
      setPhase((prev) =>
        prev.kind === 'plan' || prev.kind === 'already-seeded' ? prev : { kind: 'loading' },
      );
      seedClient()
        .plan({
          rootDir: effectiveRoot,
          packId: selectedPackId,
        })
        .then((result) => {
          if (cancelled) return;
          if (!result.ok) {
            setPhase({ kind: 'error', message: result.error.message });
            return;
          }
          // A pending pack skill counts as work even when every folder/template
          // already exists — otherwise a project whose skill was deleted (or
          // predates skills-as-content) reports "already set up" while its skill
          // is missing. `applySeed` always (re)authors the skill, so reaching
          // apply with only the skill pending fixes it.
          const hasWork = result.plan.created.length > 0 || result.plan.packSkill?.pending === true;
          setPhase(
            hasWork
              ? { kind: 'plan', plan: result.plan }
              : { kind: 'already-seeded', plan: result.plan },
          );
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        });
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, step, packs, selectedPackId, rootChoice, trimmedSubfolder, subfolderInvalid, t]);

  async function handleApply() {
    if (phase.kind !== 'plan') return;
    const planAtClick = phase.plan;
    setPhase({ kind: 'applying', plan: planAtClick });
    let result: Awaited<ReturnType<ReturnType<typeof seedClient>['apply']>>;
    try {
      result = await seedClient().apply(planAtClick, { packId: selectedPackId });
    } catch (err) {
      // Network failure / unhandled rejection — without this catch the
      // dialog stays in "Setting up…" forever. Snap back to the plan view
      // so the Initialize button remains and the user can retry without
      // closing + reopening (which would reset pack + subfolder). Toast
      // carries the error message; the plan itself is still valid.
      const errorDetail = err instanceof Error ? err.message : String(err);
      toast.error(t`Initialize failed: ${errorDetail}`);
      setPhase({ kind: 'plan', plan: planAtClick });
      return;
    }
    if (result.ok) {
      const packName = selectedPack?.name ?? t`starter pack`;
      const projectEntries = result.result.applied;
      // A skill-only apply (folders/templates already present, skill was
      // missing) writes 0 file/folder entries but DID (re)install the skill —
      // so it isn't "nothing to do".
      const skillReinstalled = planAtClick.packSkill?.pending === true;
      const message =
        projectEntries > 0
          ? t`${packName} initialized (${plural(projectEntries, { one: '# entry', other: '# entries' })})`
          : skillReinstalled
            ? t`${packName} skill installed.`
            : t`${packName} was already set up. Nothing to do.`;
      toast.success(message);
      onSeedApplied?.();
      onOpenChange(false);
    } else {
      // Same retry affordance as the catch branch above — preserve the plan
      // so the user can hit Initialize again after, e.g., fixing permissions.
      const errorDetail = result.error.message;
      toast.error(t`Initialize failed: ${errorDetail}`);
      setPhase({ kind: 'plan', plan: planAtClick });
    }
  }

  // `packLocked` distinguishes a canvas entry (pack already chosen on the
  // empty-state grid) from a dialog-only entry (e.g. command palette). When
  // unlocked, step 2 surfaces a Back button to return to the in-dialog grid.
  const packLocked = initialPackId !== undefined;
  const selectedPackName = selectedPack?.name;
  const title =
    step === 'configure' && selectedPack
      ? t`Initialize ${selectedPackName}`
      : t`Initialize a starter pack`;
  // The configure step has room for more than the one-line card blurb: a
  // sentence or two on why you'd reach for this pack and what you'd do with it.
  // Dialog-only copy, so it lives here rather than on the pack wire (a
  // drift-guarded three-way mirror). Unmapped packs fall back to the short
  // `description`.
  const packBlurbs: Partial<Record<OkPackId, string>> = {
    'knowledge-base': t`Turn the things you read into clear, trusted articles. Save a source, figure out what it means, then keep the final version so you can rely on it later.`,
    'software-lifecycle': t`Keep a written record of how your product gets built. A home for proposing ideas, recording decisions, writing specs, and capturing what you learned after something broke.`,
    'codebase-wiki': t`Explain how your codebase works so teammates and AI agents can find their way around. Good for documenting the architecture, the main parts, and the questions new contributors always ask.`,
    'plain-notes': t`A simple place to write, with one file per topic and a daily journal. Pick this if you just want to start writing and let the links between notes build up over time.`,
    okf: t`A knowledge base that follows Google's Open Knowledge Format, a shared way of organizing what you know. Pick this if you want your notes to work well with other tools that understand the format.`,
    'writing-pipeline': t`Take a piece of writing from a rough idea to a finished draft to something you're ready to share. Good for blog posts, essays, or anything you want to move through clear stages.`,
    'entity-vault': t`Keep track of the people and companies you work with and the meetings you have with them. Good for remembering who someone is, how you know them, and what you last talked about.`,
    worldbuilding: t`Build and keep track of the world behind your story. A home for your characters, places, factions, and the lore that ties them together, so details stay consistent as you write.`,
  };
  const description =
    step === 'configure' && selectedPack
      ? (packBlurbs[selectedPack.id] ?? selectedPack.description)
      : t`Ready-made folders and templates to get you started quickly.`;

  function handlePackSelect(id: OkPackId) {
    setSelectedPackId(id);
    setStep('configure');
    // Snap the next plan to fire immediately rather than after the typing
    // debounce — the user just clicked a card and expects a preview.
    isFirstLoadRef.current = true;
  }

  function handleBack() {
    setStep('pick');
    // Reset phase so a previous pack's plan doesn't briefly show under the
    // next pack's title if the user picks a different card.
    setPhase({ kind: 'loading' });
    isFirstLoadRef.current = true;
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl" data-ok-layer-spawned="">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {step === 'pick' ? (
          <DialogBody>
            <PackCardGrid packs={packs} onPackSelect={handlePackSelect} />
          </DialogBody>
        ) : (
          <DialogBody className="space-y-6">
            <RootPicker
              choice={rootChoice}
              subfolder={subfolder}
              placeholder={selectedPack?.defaultSubfolder ?? 'subfolder'}
              onChoiceChange={setRootChoice}
              onSubfolderChange={setSubfolder}
            />
            <SeedDialogBody phase={phase} selectedPack={selectedPack} />
          </DialogBody>
        )}

        <DialogFooter>
          {step === 'configure' && !packLocked ? (
            <Button className="mr-auto uppercase font-mono" variant="ghost" onClick={handleBack}>
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              <Trans>Back</Trans>
            </Button>
          ) : null}
          <Button
            className="uppercase font-mono"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {phase.kind === 'already-seeded' || phase.kind === 'error' ? (
              <Trans>Close</Trans>
            ) : (
              <Trans>Cancel</Trans>
            )}
          </Button>
          {step === 'configure' && phase.kind === 'plan' ? (
            <Button onClick={handleApply} disabled={subfolderInvalid}>
              <Trans>Initialize</Trans>
            </Button>
          ) : step === 'configure' && phase.kind === 'applying' ? (
            <Button disabled>
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              <Trans>Setting up</Trans>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

function RootPicker({
  choice,
  subfolder,
  placeholder,
  onChoiceChange,
  onSubfolderChange,
}: {
  choice: RootChoice;
  subfolder: string;
  placeholder: string;
  onChoiceChange: (next: RootChoice) => void;
  onSubfolderChange: (next: string) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="space-y-2 py-1">
      <p className="text-sm font-medium">
        <Trans>Where should it live?</Trans>
      </p>
      <RadioGroup
        className="sm:flex"
        value={choice}
        onValueChange={(next) => onChoiceChange(next as RootChoice)}
      >
        <FieldLabel htmlFor="seed-root-project-root">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>
                <Trans>Project root</Trans>
              </FieldTitle>
              <FieldDescription className="text-1sm">
                <Trans>Add it directly to this project.</Trans>
              </FieldDescription>
            </FieldContent>
            <RadioGroupItem value="project-root" id="seed-root-project-root" />
          </Field>
        </FieldLabel>
        <FieldLabel htmlFor="seed-root-subfolder">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>
                <Trans>In a subfolder</Trans>
              </FieldTitle>
              <FieldDescription className="nth-last-2:mt-0 text-1sm">
                <Trans>Reused if it already exists, created if not.</Trans>
              </FieldDescription>
              {choice === 'subfolder' && (
                <Input
                  value={subfolder}
                  onChange={(e) => onSubfolderChange(e.target.value)}
                  placeholder={placeholder}
                  aria-label={t`Subfolder name`}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="mt-1.5 font-mono text-xs bg-background"
                />
              )}
            </FieldContent>
            <RadioGroupItem value="subfolder" id="seed-root-subfolder" />
          </Field>
        </FieldLabel>
      </RadioGroup>
    </div>
  );
}

function SeedDialogBody({
  phase,
  selectedPack,
}: {
  phase: DialogPhase;
  selectedPack: OkSeedPackInfo | undefined;
}) {
  const { t } = useLingui();
  if (phase.kind === 'loading') {
    // Card-sized skeleton blocks in the same grid as the real cards, so the
    // plan swaps in without a layout jump. Count tracks the pack's folders (the
    // dominant card kind). `role="status"` so assistive tech hears it loading.
    const cardCount = selectedPack?.folders.length ?? 6;
    return (
      <section
        className="@container/created"
        role="status"
        aria-busy="true"
        aria-label={t`Loading preview`}
      >
        <div className="grid gap-3 @sm/created:grid-cols-2 @2xl/created:grid-cols-3">
          {Array.from({ length: cardCount }, (_, i) => i).map((i) => (
            <div
              key={`seed-skeleton-${i}`}
              aria-hidden="true"
              className="h-20 animate-pulse rounded-xl bg-muted"
            />
          ))}
        </div>
      </section>
    );
  }

  if (phase.kind === 'error') {
    return (
      <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
        {phase.message}
      </div>
    );
  }

  if (phase.kind === 'already-seeded') {
    return (
      <div className="py-2 text-sm">
        <p className="font-medium">
          <Trans>This pack is already set up here.</Trans>
        </p>
        <p className="text-muted-foreground">
          <Trans>The folders and templates are already here, so there's nothing to add.</Trans>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 py-1 text-sm">
      {phase.plan.created.length > 0 || phase.plan.packSkill?.pending ? (
        <CreatedItemsList plan={phase.plan} selectedPack={selectedPack} />
      ) : null}
      {phase.plan.warnings.length > 0 ? (
        <div className="rounded-md bg-warning/10 p-3 text-xs text-warning-foreground">
          {phase.plan.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

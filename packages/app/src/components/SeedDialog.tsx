import { planHasOutstandingWork } from '@inkeep/open-knowledge-core';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowLeft } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CreatedItemsList, CreatedItemsSkeleton } from '@/components/CreatedItemsList';
import { PackCardGrid } from '@/components/PackCardGrid';
import { type SeedRootChoice, SeedRootPicker } from '@/components/SeedRootPicker';
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
import { Spinner } from '@/components/ui/spinner';
import type { OkPackId, OkScaffoldPlan, OkSeedPackInfo } from '@/lib/desktop-bridge-types';
import { PACK_BLURBS } from '@/lib/pack-copy';
import { seedClient } from '@/lib/seed-client';

const DEFAULT_PACK_ID: OkPackId = 'knowledge-base';

interface SeedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSeedApplied?: () => void;
  initialPackId?: OkPackId;
}

type DialogPhase =
  | { kind: 'loading' }
  | { kind: 'plan'; plan: OkScaffoldPlan }
  | { kind: 'already-seeded'; plan: OkScaffoldPlan }
  | { kind: 'error'; message: string }
  | { kind: 'applying'; plan: OkScaffoldPlan };

type DialogStep = 'pick' | 'configure';

export function SeedDialog({ open, onOpenChange, onSeedApplied, initialPackId }: SeedDialogProps) {
  const { t } = useLingui();
  const [phase, setPhase] = useState<DialogPhase>({ kind: 'loading' });
  const [packs, setPacks] = useState<OkSeedPackInfo[] | null>(null);
  const [selectedPackId, setSelectedPackId] = useState<OkPackId>(initialPackId ?? DEFAULT_PACK_ID);
  const [rootChoice, setRootChoice] = useState<SeedRootChoice>('project-root');
  const [subfolder, setSubfolder] = useState<string>('');
  const [step, setStep] = useState<DialogStep>(initialPackId !== undefined ? 'configure' : 'pick');
  const isFirstLoadRef = useRef(true);

  const selectedPack = packs?.find((p) => p.id === selectedPackId);

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
          setPacks([]);
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

  useEffect(() => {
    if (!selectedPack) return;
    setSubfolder(selectedPack.defaultSubfolder ?? '');
  }, [selectedPack]);

  const trimmedSubfolder = subfolder.trim();
  const subfolderInvalid = rootChoice === 'subfolder' && trimmedSubfolder === '';

  useEffect(() => {
    if (!open) return;
    if (step !== 'configure') return;
    if (packs === null) return;

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
          const hasWork = planHasOutstandingWork(result.plan);
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
      const errorDetail = err instanceof Error ? err.message : String(err);
      toast.error(t`Initialize failed: ${errorDetail}`);
      setPhase({ kind: 'plan', plan: planAtClick });
      return;
    }
    if (result.ok) {
      const packName = selectedPack?.name ?? t`starter pack`;
      const projectEntries = result.result.applied;
      const skillReinstalled = planAtClick.packSkills?.some((s) => s.pending) === true;
      const message =
        projectEntries > 0
          ? t`${packName} initialized (${plural(projectEntries, { one: '# entry', other: '# entries' })})`
          : skillReinstalled
            ? t`${packName} skill installed.`
            : t`${packName} was already set up. Nothing to do.`;
      toast.success(message);
      for (const conflict of result.result.packSkillConflicts ?? []) {
        const conflictName = conflict.name;
        const conflictHosts = conflict.hosts?.join(', ');
        toast.warning(
          conflictHosts === undefined || conflictHosts === ''
            ? t`Skill "${conflictName}" was not installed — you already have your own skill with that name. Rename yours if you want the pack's version.`
            : t`Skill "${conflictName}" was not installed for ${conflictHosts} — you already have your own skill with that name there. Rename yours if you want the pack's version.`,
        );
      }
      onSeedApplied?.();
      onOpenChange(false);
    } else {
      const errorDetail = result.error.message;
      toast.error(t`Initialize failed: ${errorDetail}`);
      setPhase({ kind: 'plan', plan: planAtClick });
    }
  }

  const packLocked = initialPackId !== undefined;
  const selectedPackName = selectedPack?.name;
  const title =
    step === 'configure' && selectedPack
      ? t`Initialize ${selectedPackName}`
      : t`Initialize a starter pack`;
  const packBlurb = selectedPack ? PACK_BLURBS[selectedPack.id] : undefined;
  const description =
    step === 'configure' && selectedPack
      ? packBlurb
        ? t(packBlurb)
        : selectedPack.description
      : t`Ready-made folders and templates to get you started quickly.`;

  function handlePackSelect(id: OkPackId) {
    setSelectedPackId(id);
    setStep('configure');
    isFirstLoadRef.current = true;
  }

  function handleBack() {
    setStep('pick');
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
            <SeedRootPicker
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
            <Button className="me-auto uppercase font-mono" variant="ghost" onClick={handleBack}>
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
              <Spinner aria-hidden="true" className="h-4 w-4" />
              <Trans>Setting up</Trans>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

function SeedDialogBody({
  phase,
  selectedPack,
}: {
  phase: DialogPhase;
  selectedPack: OkSeedPackInfo | undefined;
}) {
  if (phase.kind === 'loading') {
    return <CreatedItemsSkeleton rowCount={selectedPack?.folders.length ?? 6} />;
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
      <div className="space-y-3 py-2 text-sm">
        <div>
          <p className="font-medium">
            <Trans>This pack is already set up here.</Trans>
          </p>
          <p className="text-muted-foreground">
            <Trans>The folders and templates are already here, so there's nothing to add.</Trans>
          </p>
        </div>
        {}
        <PackSkillConflicts plan={phase.plan} />
      </div>
    );
  }

  return (
    <div className="space-y-6 py-1 text-sm">
      {planHasOutstandingWork(phase.plan) ? (
        <CreatedItemsList plan={phase.plan} selectedPack={selectedPack} />
      ) : null}
      {phase.plan.warnings.length > 0 ? (
        <div className="rounded-md bg-warning/10 p-3 text-xs text-warning-foreground">
          {phase.plan.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      ) : null}
      <PackSkillConflicts plan={phase.plan} />
    </div>
  );
}

function PackSkillConflicts({ plan }: { plan: OkScaffoldPlan }): ReactElement | null {
  const conflicts = plan.packSkills?.filter((s) => s.conflict) ?? [];
  if (conflicts.length === 0) return null;
  return (
    <div className="rounded-md bg-warning/10 p-3 text-xs text-warning-foreground">
      {conflicts.map((s) => (
        <p key={s.name}>
          <Trans>
            You already have your own skill named "{s.name}" — the pack's version will not be
            installed, and yours won't be touched. Rename yours to install the pack's version.
          </Trans>
        </p>
      ))}
    </div>
  );
}

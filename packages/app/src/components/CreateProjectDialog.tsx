import {
  CREATE_NEW_PROJECT_FAILURE_REASONS,
  type CreateNewBannerKind,
  type CreateNewProjectFailureReason,
  receivesProjectIntegrationWrite,
  sanitizeFolderName,
} from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ArrowLeft } from 'lucide-react';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CreatedItemsList, CreatedItemsSkeleton } from '@/components/CreatedItemsList';
import { PackCardGrid } from '@/components/PackCardGrid';
import { ProjectAiToolsField } from '@/components/ProjectAiToolsField';
import { type SeedRootChoice, SeedRootPicker } from '@/components/SeedRootPicker';
import {
  DEFAULT_SHARING_MODE,
  type SharingMode,
  SharingModeField,
} from '@/components/SharingModeField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type {
  OkDesktopBridge,
  OkFindEnclosingGitRootResult,
  OkFindEnclosingProjectRootResult,
  OkFolderState,
  OkMcpWiringEditorId,
  OkPackId,
  OkScaffoldPlan,
  OkSeedPackInfo,
} from '@/lib/desktop-bridge-types';
import { PACK_BLURBS } from '@/lib/pack-copy';
import { seedClient } from '@/lib/seed-client';
import { cn } from '@/lib/utils';

const PROBE_DEBOUNCE_MS = 180;

const GIT_BANNER_POLL_INTERVAL_MS = 5_000;

const PACK_PREVIEW_DEBOUNCE_MS = 200;

type SettledCascade =
  | { kind: 'idle' }
  | { kind: 'block-nested'; rootPath: string }
  | { kind: 'confirm-git'; gitRoot: string }
  | { kind: 'block-nonempty' }
  | { kind: 'free' };

type ProbeLifecycle = 'idle' | 'in-flight';

type PackPreview =
  | { kind: 'loading' }
  | { kind: 'plan'; plan: OkScaffoldPlan }
  | { kind: 'error'; message: string; blocking: boolean };

type RemoveGitState =
  | { kind: 'idle' }
  | { kind: 'confirming'; gitRoot: string }
  | { kind: 'pending'; gitRoot: string }
  | { kind: 'error'; message: string };

type CreateNewError =
  | { reason: 'nested-project'; rootPath?: string }
  | { reason: 'target-not-empty' }
  | { reason: 'invalid-args'; message: string }
  | { reason: 'mkdir-failed'; message: string }
  | { reason: 'git-init-failed'; message: string }
  | { reason: 'init-failed'; message: string }
  | { reason: 'discovery-failed'; message: string }
  | { reason: 'unknown'; message: string };

type _Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _CREATE_NEW_REASON_DRIFT_PIN: _Equals<
  CreateNewProjectFailureReason,
  Exclude<CreateNewError['reason'], 'unknown'>
> = true;
void _CREATE_NEW_REASON_DRIFT_PIN;

type CreateStep = 'pick' | 'review' | 'configure';

function focusStepPrimary(
  next: CreateStep,
  targets: {
    reviewContinueRef: RefObject<HTMLButtonElement | null>;
    nameInputRef: RefObject<HTMLInputElement | null>;
    packGridRef: RefObject<HTMLDivElement | null>;
  },
) {
  if (next === 'review') {
    targets.reviewContinueRef.current?.focus();
    return;
  }
  if (next === 'configure') {
    targets.nameInputRef.current?.focus();
    return;
  }
  targets.packGridRef.current?.querySelector<HTMLElement>('[data-slot="pack-card"]')?.focus();
}

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bridge: OkDesktopBridge;
  initialPackId?: OkPackId;
  packs?: OkSeedPackInfo[];
}

export function joinPathPreview(parent: string, basename: string): string {
  if (parent === '' || basename === '') return '';
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  const trimmed = parent.replace(/[/\\]+$/, '');
  return `${trimmed}${sep}${basename}`;
}

export function basenamePreview(path: string): string {
  if (path === '') return '';
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments.length > 0 ? (segments[segments.length - 1] ?? path) : path;
}

export function computeCascade(input: {
  parent: string;
  sanitizedName: string;
  enclosingProject: OkFindEnclosingProjectRootResult | null;
  enclosingGit: OkFindEnclosingGitRootResult | null;
  targetState: OkFolderState | null;
}): SettledCascade {
  const { parent, sanitizedName, enclosingProject, enclosingGit, targetState } = input;
  if (parent === '' || sanitizedName === '') return { kind: 'idle' };
  if (enclosingProject !== null) {
    return { kind: 'block-nested', rootPath: enclosingProject.rootPath };
  }
  if (enclosingGit !== null) {
    return { kind: 'confirm-git', gitRoot: enclosingGit.gitRoot };
  }
  if (targetState === 'exists-nonempty') return { kind: 'block-nonempty' };
  return { kind: 'free' };
}

export function parseCreateNewError(err: unknown): CreateNewError {
  const message = err instanceof Error ? err.message : String(err);
  for (const reason of CREATE_NEW_PROJECT_FAILURE_REASONS) {
    if (message.startsWith(`${reason}:`) || message.includes(`${reason}: `)) {
      if (reason === 'nested-project' || reason === 'target-not-empty') {
        return { reason };
      }
      return { reason, message };
    }
  }
  return { reason: 'unknown', message };
}

function errorCopy(err: CreateNewError): MessageDescriptor {
  switch (err.reason) {
    case 'nested-project':
      return msg`A project already exists at this location. Pick a different parent folder.`;
    case 'target-not-empty':
      return msg`A non-empty folder already exists at this path. Pick a different folder.`;
    case 'invalid-args':
      return msg`Invalid input — pick a different folder.`;
    case 'mkdir-failed':
      return msg`Could not create the project folder. Pick a different folder.`;
    case 'git-init-failed':
      return msg`Project folder created, but git init failed. Try again.`;
    case 'init-failed':
      return msg`Could not write project files. Try a different location.`;
    case 'discovery-failed':
      return msg`Could not finalize project setup. Try again.`;
    case 'unknown':
      return msg`Could not create project. Try again or pick a different location.`;
  }
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  bridge,
  initialPackId,
  packs,
}: CreateProjectDialogProps) {
  const { t } = useLingui();
  const formId = useId();
  const nameInputId = useId();
  const captionId = useId();
  const nameErrorId = useId();
  const [location, setLocation] = useState('');
  const [locationResolving, setLocationResolving] = useState(false);
  const [name, setName] = useState('');
  const [detectedEditors, setDetectedEditors] = useState<readonly OkMcpWiringEditorId[] | null>(
    null,
  );
  const [connectEditors, setConnectEditors] = useState(true);
  const [sharing, setSharing] = useState<SharingMode>(DEFAULT_SHARING_MODE);
  const [packId, setPackId] = useState<OkPackId | undefined>(initialPackId);
  const [step, setStep] = useState<CreateStep>('configure');
  const [rootChoice, setRootChoice] = useState<SeedRootChoice>('project-root');
  const [subfolder, setSubfolder] = useState('');
  const [packPreview, setPackPreview] = useState<PackPreview>({ kind: 'loading' });
  const hasPackList = (packs?.length ?? 0) > 0;
  const initialPackResolves =
    initialPackId !== undefined && (packs?.some((pack) => pack.id === initialPackId) ?? false);
  const packPlanActive = step !== 'pick';
  const packSkillCount =
    packPreview.kind === 'plan' ? (packPreview.plan.packSkills?.length ?? 0) : 0;
  const [cascade, setCascade] = useState<SettledCascade>({ kind: 'idle' });
  const [probeLifecycle, setProbeLifecycle] = useState<ProbeLifecycle>('idle');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<CreateNewError | null>(null);
  const [removeGitState, setRemoveGitState] = useState<RemoveGitState>({ kind: 'idle' });
  const [probeNonce, setProbeNonce] = useState(0);

  const firedBanners = useRef<Set<CreateNewBannerKind>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const reviewContinueRef = useRef<HTMLButtonElement | null>(null);
  const packGridRef = useRef<HTMLDivElement | null>(null);

  const goToStep = (next: CreateStep) => {
    setStep(next);
    requestAnimationFrame(() =>
      focusStepPrimary(next, { reviewContinueRef, nameInputRef, packGridRef }),
    );
  };
  const removeGitCallIdRef = useRef(0);
  const previewFirstLoadRef = useRef(true);

  useEffect(() => {
    if (!open) return;
    firedBanners.current.clear();
    setSubmitError(null);
    setCascade({ kind: 'idle' });
    setProbeLifecycle('idle');
    setBusy(false);
    setName('');
    setDetectedEditors(null);
    setConnectEditors(true);
    setSharing(DEFAULT_SHARING_MODE);
    setRemoveGitState({ kind: 'idle' });
    setPackId(initialPackId);
    const openingStep = initialPackResolves ? 'review' : hasPackList ? 'pick' : 'configure';
    setStep(openingStep);
    setRootChoice('project-root');
    setPackPreview({ kind: 'loading' });
    previewFirstLoadRef.current = true;
    removeGitCallIdRef.current += 1;

    let cancelled = false;
    bridge.integrations
      .status()
      .then((status) => {
        if (cancelled) return;
        const userMcpInstalled = new Set(
          status.editors.filter((e) => e.state === 'installed').map((e) => e.id),
        );
        setDetectedEditors(
          status.detectedEditorIds.filter((id) =>
            receivesProjectIntegrationWrite(id, {
              userMcpEntryInstalled: userMcpInstalled.has(id),
            }),
          ),
        );
      })
      .catch((err) => {
        console.warn('[CreateProjectDialog] editor-detection probe failed:', err);
        if (!cancelled) setDetectedEditors([]);
      });

    setLocation('');
    setLocationResolving(true);
    bridge.fs
      .defaultProjectsRoot()
      .then((root) => {
        if (!cancelled) setLocation(root);
      })
      .catch((err) => {
        console.warn('[CreateProjectDialog] defaultProjectsRoot probe failed:', err);
      })
      .finally(() => {
        if (!cancelled) setLocationResolving(false);
      });

    const raf = requestAnimationFrame(() =>
      focusStepPrimary(openingStep, { reviewContinueRef, nameInputRef, packGridRef }),
    );

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [open, bridge, initialPackId, hasPackList, initialPackResolves]);

  const selectedPack = packs?.find((pack) => pack.id === packId);

  const selectedPackSubfolderDefault = selectedPack?.defaultSubfolder ?? '';
  useEffect(() => {
    void open;
    if (packId === undefined) return;
    setSubfolder(selectedPackSubfolderDefault);
  }, [open, packId, selectedPackSubfolderDefault]);

  const trimmedSubfolder = subfolder.trim();
  const subfolderInvalid =
    selectedPack !== undefined && rootChoice === 'subfolder' && trimmedSubfolder === '';
  const packRootDir = rootChoice === 'project-root' ? undefined : trimmedSubfolder;
  const skillsInstallable = connectEditors && (detectedEditors?.length ?? 0) > 0;

  useEffect(() => {
    if (!open) return;
    if (selectedPack === undefined) return;
    if (!packPlanActive) return;
    if (subfolderInvalid) {
      setPackPreview({
        kind: 'error',
        message: t`Enter a folder name (e.g. brain).`,
        blocking: true,
      });
      return;
    }

    const delay = previewFirstLoadRef.current ? 0 : PACK_PREVIEW_DEBOUNCE_MS;
    previewFirstLoadRef.current = false;

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setPackPreview((prev) => (prev.kind === 'plan' ? prev : { kind: 'loading' }));
      seedClient()
        .plan({
          rootDir: packRootDir,
          packId: selectedPack.id,
          preview: { skillsInstallable },
        })
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            setPackPreview({ kind: 'plan', plan: result.plan });
            return;
          }
          const blocking = result.error.kind === 'invalid-root';
          if (!blocking) {
            console.warn('[CreateProjectDialog] pack preview unavailable:', result.error);
          }
          setPackPreview({
            kind: 'error',
            message: blocking ? result.error.message : t`Pack preview unavailable.`,
            blocking,
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          console.warn('[CreateProjectDialog] pack preview plan failed:', err);
          setPackPreview({
            kind: 'error',
            message: t`Pack preview unavailable.`,
            blocking: false,
          });
        });
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, packPlanActive, selectedPack, packRootDir, subfolderInvalid, skillsInstallable, t]);

  useEffect(() => {
    void probeNonce;
    if (!open) return;
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    if (abortRef.current !== null) abortRef.current.abort();

    const sanitized = sanitizeFolderName(name);
    if (location === '' || sanitized === '') {
      setCascade({ kind: 'idle' });
      setProbeLifecycle('idle');
      return;
    }
    const parent = location;
    const target = joinPathPreview(parent, sanitized);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    debounceRef.current = setTimeout(() => {
      setProbeLifecycle('in-flight');
      Promise.all([
        bridge.fs.findEnclosingProjectRoot(parent),
        bridge.fs.findEnclosingGitRoot(parent),
        bridge.fs.folderState(target),
      ])
        .then(([enclosingProject, enclosingGit, targetState]) => {
          if (ctrl.signal.aborted) return;
          setProbeLifecycle('idle');
          const nextCascade = computeCascade({
            parent,
            sanitizedName: sanitized,
            enclosingProject,
            enclosingGit,
            targetState,
          });
          setCascade(nextCascade);
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          console.warn('[CreateProjectDialog] cascade probe failed:', err);
          setProbeLifecycle('idle');
          setCascade({ kind: 'free' });
        });
    }, PROBE_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      ctrl.abort();
    };
  }, [open, location, name, bridge, probeNonce]);

  useEffect(() => {
    if (!open) return;
    const onFocus = () => setProbeNonce((n) => n + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [open]);

  const probeLifecycleRef = useRef<ProbeLifecycle>('idle');
  useEffect(() => {
    probeLifecycleRef.current = probeLifecycle;
  }, [probeLifecycle]);

  useEffect(() => {
    if (!open) return;
    if (cascade.kind !== 'confirm-git') return;
    const id = setInterval(() => {
      if (probeLifecycleRef.current === 'in-flight') return;
      setProbeNonce((n) => n + 1);
    }, GIT_BANNER_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [open, cascade.kind]);

  useEffect(() => {
    if (cascade.kind !== 'confirm-git') {
      if (removeGitState.kind !== 'idle') {
        removeGitCallIdRef.current += 1;
        setRemoveGitState({ kind: 'idle' });
      }
      return;
    }
    if (removeGitState.kind === 'confirming' && removeGitState.gitRoot !== cascade.gitRoot) {
      setRemoveGitState({ kind: 'idle' });
    }
    if (removeGitState.kind === 'pending' && removeGitState.gitRoot !== cascade.gitRoot) {
      removeGitCallIdRef.current += 1;
      setRemoveGitState({ kind: 'idle' });
    }
  }, [cascade, removeGitState]);

  useEffect(() => {
    if (!open) return;
    let banner: CreateNewBannerKind | null = null;
    if (cascade.kind === 'block-nested') banner = 'nested';
    else if (cascade.kind === 'block-nonempty') banner = 'nonempty';
    else if (cascade.kind === 'confirm-git') banner = 'git-confirm';
    if (banner === null) return;
    if (firedBanners.current.has(banner)) return;
    firedBanners.current.add(banner);
    bridge.project.recordCreateNewBannerShown(banner).catch(() => {});
  }, [open, cascade, bridge]);

  const rawName = name;
  const sanitized = rawName === '' ? '' : sanitizeFolderName(rawName);
  const sanitizeDiverged = rawName !== '' && sanitized !== rawName && sanitized !== '';
  const sanitizeErased = rawName !== '' && sanitized === '';
  const nameTaken = cascade.kind === 'block-nonempty';
  const targetPreview =
    location !== '' && sanitized !== '' ? joinPathPreview(location, sanitized) : '';
  const canSubmit =
    !busy &&
    location !== '' &&
    rawName !== '' &&
    sanitized !== '' &&
    !subfolderInvalid &&
    (selectedPack === undefined || packPreview.kind !== 'error' || !packPreview.blocking) &&
    probeLifecycle === 'idle' &&
    (cascade.kind === 'free' || cascade.kind === 'confirm-git');
  const detectionPending = connectEditors && detectedEditors === null;
  const submitDisabled = busy || detectionPending || (rawName !== '' && !canSubmit);

  async function onBrowse() {
    try {
      const pickedParent = await bridge.dialog.openFolder(
        location !== '' ? { defaultPath: location } : undefined,
      );
      if (pickedParent === null) return;
      setLocation(pickedParent);
      setProbeNonce((n) => n + 1);
      setSubmitError(null);
    } catch (err) {
      console.warn('[CreateProjectDialog] dialog.openFolder failed:', err);
    }
  }

  async function onSubmit(e: React.SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    e.preventDefault();
    if (busy) return;
    if (rawName.trim() === '') {
      toast.error(t`Enter a project name`);
      nameInputRef.current?.focus();
      return;
    }
    if (!canSubmit) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await bridge.project.createNew({
        parent: location,
        name: sanitized,
        editors: connectEditors ? [...(detectedEditors ?? [])] : [],
        sharing,
        packId,
        rootDir: packRootDir,
      });
      onOpenChange(false);
    } catch (err) {
      setSubmitError(parseCreateNewError(err));
      setBusy(false);
    }
  }

  function onOpenChangeInternal(next: boolean) {
    if (busy) return;
    onOpenChange(next);
  }

  async function onRequestRemoveGit(gitRoot: string) {
    setRemoveGitState({ kind: 'confirming', gitRoot });
  }

  async function onCancelRemoveGit() {
    setRemoveGitState({ kind: 'idle' });
  }

  async function onConfirmRemoveGit(gitRoot: string) {
    const callId = removeGitCallIdRef.current + 1;
    removeGitCallIdRef.current = callId;
    setRemoveGitState({ kind: 'pending', gitRoot });
    try {
      await bridge.fs.removeGitFolder(gitRoot);
      if (removeGitCallIdRef.current !== callId) return;
      setProbeNonce((n) => n + 1);
      setRemoveGitState({ kind: 'idle' });
    } catch (err) {
      if (removeGitCallIdRef.current !== callId) return;
      const message = err instanceof Error ? err.message : String(err);
      console.error('[CreateProjectDialog] bridge.fs.removeGitFolder failed:', err);
      setRemoveGitState({ kind: 'error', message });
    }
  }

  async function onOpenNested(rootPath: string) {
    onOpenChange(false);
    try {
      await bridge.project.open({
        path: rootPath,
        target: 'new-window',
        entryPoint: 'create-new-nested-redirect',
      });
    } catch (err) {
      console.warn('[CreateProjectDialog] project.open failed:', err);
    }
  }

  const nameDescribedBy =
    sanitizeErased || nameTaken || sanitizeDiverged ? `${captionId} ${nameErrorId}` : captionId;

  const canChangePack = packId !== undefined && hasPackList;
  const selectedPackName = selectedPack?.name;
  const selectedPackBlurb = selectedPack ? PACK_BLURBS[selectedPack.id] : undefined;
  const stepAnnouncement =
    step === 'pick'
      ? t`Starter packs`
      : step === 'review'
        ? t`Reviewing what this pack adds`
        : t`Project details`;
  const title =
    selectedPackName !== undefined
      ? t`Create new project from ${selectedPackName}`
      : t`Create new project`;
  const description =
    selectedPack === undefined
      ? t`Create a new OpenKnowledge project in the folder of your choice.`
      : selectedPackBlurb
        ? t(selectedPackBlurb)
        : selectedPack.description;

  return (
    <Dialog open={open} onOpenChange={onOpenChangeInternal}>
      <DialogContent
        className={cn('sm:max-w-lg', step === 'pick' && 'sm:max-w-3xl')}
        data-testid="create-project-dialog"
      >
        {}
        <span aria-live="polite" className="sr-only" data-testid="create-step-announcer">
          {stepAnnouncement}
        </span>

        <DialogHeader>
          <DialogTitle>{step === 'pick' ? t`Starter packs` : title}</DialogTitle>
          <DialogDescription>
            {step === 'pick'
              ? t`Each pack scaffolds your project with ready-made folders and templates.`
              : step === 'review'
                ? t`Here's what this pack adds to your project. Nothing is written until you create the project.`
                : description}
          </DialogDescription>
        </DialogHeader>

        {step === 'pick' ? (
          <DialogBody ref={packGridRef}>
            <PackCardGrid
              packs={packs ?? null}
              onPackSelect={(id) => {
                setPackId(id);
                if (id !== packId) setRootChoice('project-root');
                previewFirstLoadRef.current = true;
                setPackPreview({ kind: 'loading' });
                goToStep('review');
              }}
            />
          </DialogBody>
        ) : step === 'review' ? (
          selectedPack === undefined ? null : (
            <DialogBody data-testid="create-review-body">
              {packPreview.kind === 'error' ? (
                <div
                  role="alert"
                  className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
                  data-testid="create-pack-preview-error"
                >
                  {packPreview.message}
                </div>
              ) : packPreview.kind === 'plan' ? (
                <CreatedItemsList plan={packPreview.plan} selectedPack={selectedPack} />
              ) : (
                <CreatedItemsSkeleton rowCount={selectedPack.folders.length} />
              )}
            </DialogBody>
          )
        ) : (
          <DialogBody className="space-y-6">
            <form
              id={formId}
              onSubmit={onSubmit}
              data-testid="create-project-form"
              className="space-y-6"
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor={nameInputId}>
                  <Trans>Project name</Trans>
                </Label>
                <Input
                  id={nameInputId}
                  ref={nameInputRef}
                  value={name}
                  placeholder={t`Team Wiki`}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  autoComplete="off"
                  aria-invalid={sanitizeErased || nameTaken}
                  aria-describedby={nameDescribedBy}
                  data-testid="create-name"
                />
                {sanitizeErased ? (
                  <p
                    id={nameErrorId}
                    role="alert"
                    className="text-1sm text-destructive"
                    data-testid="create-name-error-erased"
                  >
                    <Trans>Add at least one letter or number.</Trans>
                  </p>
                ) : nameTaken ? (
                  <p
                    id={nameErrorId}
                    role="alert"
                    className="text-1sm text-destructive"
                    data-testid="create-name-error-taken"
                  >
                    <Trans>
                      A folder named <code className="font-mono break-all">{sanitized}</code>{' '}
                      already has files here. Pick a different name.
                    </Trans>
                  </p>
                ) : sanitizeDiverged ? (
                  <p
                    id={nameErrorId}
                    role="status"
                    aria-live="polite"
                    className="text-1sm text-muted-foreground"
                    data-testid="create-name-hint-diverged"
                  >
                    <Trans>
                      Will be saved as <code className="font-mono break-all">{sanitized}</code>.
                    </Trans>
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-2">
                {}
                <Label>
                  <Trans>Location</Trans>
                </Label>
                <div className="flex items-center gap-2">
                  <div
                    className="min-w-0 flex-1 rounded-md border border-input bg-muted/50 px-2.5 py-1 text-sm text-foreground wrap-break-word"
                    data-testid="create-location-display"
                  >
                    {location !== '' ? (
                      location
                    ) : locationResolving ? (
                      <span className="text-muted-foreground">
                        <Trans>Resolving default location</Trans>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        <Trans>No location selected. Use Browse to choose a folder.</Trans>
                      </span>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    disabled={busy}
                    onClick={() => void onBrowse()}
                    data-testid="create-browse"
                  >
                    <Trans>Browse</Trans>
                  </Button>
                </div>
                <p
                  id={captionId}
                  className="text-1sm text-muted-foreground wrap-break-word"
                  aria-live="polite"
                  data-testid="create-target-caption"
                >
                  {targetPreview !== '' ? (
                    <Trans>
                      Will be created at:{' '}
                      <code className="font-mono break-all">{targetPreview}</code>
                    </Trans>
                  ) : null}
                </p>
              </div>

              <CascadeBanner
                cascade={cascade}
                onOpenNested={onOpenNested}
                removeGitState={removeGitState}
                onRequestRemoveGit={onRequestRemoveGit}
                onCancelRemoveGit={onCancelRemoveGit}
                onConfirmRemoveGit={onConfirmRemoveGit}
              />

              {selectedPack ? (
                <div className="space-y-6" data-testid="create-pack-section">
                  <SeedRootPicker
                    choice={rootChoice}
                    subfolder={subfolder}
                    placeholder={selectedPack.defaultSubfolder ?? 'subfolder'}
                    idPrefix="create-seed-root"
                    onChoiceChange={setRootChoice}
                    onSubfolderChange={setSubfolder}
                  />
                  {}
                  {cascade.kind === 'confirm-git' ? (
                    <p
                      className="text-1sm text-muted-foreground"
                      data-testid="create-pack-promoted-note"
                    >
                      <Trans>
                        OpenKnowledge is set up at the repository root here, so the pack goes inside{' '}
                        <code className="font-mono break-all">{sanitized}</code> rather than at the
                        top of the repository.
                      </Trans>
                    </p>
                  ) : null}
                  {}
                  {packPreview.kind === 'error' && packPreview.blocking ? (
                    <div
                      role="alert"
                      className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
                      data-testid="create-pack-preview-error"
                    >
                      {packPreview.message}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {}
              <ProjectAiToolsField
                detectedEditors={detectedEditors}
                checked={connectEditors}
                onCheckedChange={setConnectEditors}
                disabled={busy}
                testIdPrefix="create-editors"
                itemTestIdPrefix="create-editor"
              />

              {}
              {packSkillCount > 0 ? (
                <p className="text-1sm text-muted-foreground" data-testid="create-pack-skills-note">
                  {skillsInstallable ? (
                    <Trans>
                      This also installs the pack's{' '}
                      <Plural value={packSkillCount} one="# skill" other="# skills" />.
                    </Trans>
                  ) : (
                    <Trans>
                      Without a connected AI tool, the pack's{' '}
                      <Plural value={packSkillCount} one="# skill" other="# skills" /> won't be
                      installed.
                    </Trans>
                  )}
                </p>
              ) : null}

              <SharingModeField
                idPrefix="create"
                testIdPrefix="create-sharing"
                value={sharing}
                onValueChange={setSharing}
                disabled={busy}
              />

              {submitError !== null ? (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  data-testid="create-submit-error"
                >
                  {t(errorCopy(submitError))}
                </div>
              ) : null}
            </form>
          </DialogBody>
        )}

        <DialogFooter>
          {}
          {(step === 'configure' || step === 'review') && canChangePack ? (
            <Button
              type="button"
              variant="ghost"
              className="me-auto font-mono uppercase"
              onClick={() => goToStep('pick')}
              disabled={busy}
              data-testid="create-change-pack"
            >
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              <Trans>Change pack</Trans>
            </Button>
          ) : null}
          {}
          {step !== 'review' ? (
            <Button
              type="button"
              variant="outline"
              className="font-mono uppercase"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              data-testid="create-cancel"
            >
              <Trans>Cancel</Trans>
            </Button>
          ) : null}
          {step === 'review' ? (
            <Button
              type="button"
              ref={reviewContinueRef}
              onClick={() => goToStep('configure')}
              data-testid="create-review-continue"
            >
              <Trans>Use this starter pack</Trans>
            </Button>
          ) : null}
          {step === 'configure' ? (
            <Button
              type="submit"
              form={formId}
              disabled={submitDisabled}
              data-testid="create-submit"
            >
              {busy ? <Trans>Creating</Trans> : <Trans>Create</Trans>}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CascadeBannerProps {
  cascade: SettledCascade;
  onOpenNested: (rootPath: string) => void;
  removeGitState: RemoveGitState;
  onRequestRemoveGit: (gitRoot: string) => void;
  onCancelRemoveGit: () => void;
  onConfirmRemoveGit: (gitRoot: string) => void;
}

function CascadeBanner({
  cascade,
  onOpenNested,
  removeGitState,
  onRequestRemoveGit,
  onCancelRemoveGit,
  onConfirmRemoveGit,
}: CascadeBannerProps) {
  if (cascade.kind === 'idle' || cascade.kind === 'free' || cascade.kind === 'block-nonempty') {
    return null;
  }
  if (cascade.kind === 'block-nested') {
    const { rootPath } = cascade;
    const basename = basenamePreview(rootPath);
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        data-testid="create-banner-nested"
      >
        <p className="mb-2">
          <Trans>
            Can't nest projects. An OpenKnowledge project already exists at{' '}
            <code className="font-mono break-all">{rootPath}</code>. Choose a location outside it,
            or open that project instead.
          </Trans>
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenNested(rootPath)}
          data-testid="create-banner-nested-open"
        >
          <Trans>Open {basename}</Trans>
        </Button>
      </div>
    );
  }
  if (cascade.kind === 'confirm-git') {
    const { gitRoot } = cascade;
    const targetGitPath = `${gitRoot.replace(/\/+$/, '')}/.git`;
    const removeGitError = removeGitState.kind === 'error' ? removeGitState.message : null;
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-200"
        data-testid="create-banner-git-confirm"
      >
        <p>
          <Trans>
            OpenKnowledge will be initialized at <code>{gitRoot}</code> — the parent of your new
            folder, because it contains a <code>.git</code> folder (one project per git repo).
          </Trans>
        </p>
        {removeGitState.kind === 'idle' || removeGitState.kind === 'error' ? (
          <div className="mt-2 flex flex-col gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onRequestRemoveGit(gitRoot)}
              data-testid="create-banner-git-remove"
            >
              <Trans>
                Remove the parent <code>.git</code> folder
              </Trans>
            </Button>
            {removeGitState.kind === 'error' ? (
              <p
                role="alert"
                className="text-xs text-destructive"
                data-testid="create-banner-git-remove-error"
              >
                <Trans>
                  Couldn't remove <code>{targetGitPath}</code>: {removeGitError}
                </Trans>
              </p>
            ) : null}
          </div>
        ) : (
          <div
            className="mt-2 flex flex-col gap-2 rounded border border-blue-400/60 bg-white/40 p-2 dark:border-blue-600/60 dark:bg-black/20"
            data-testid="create-banner-git-remove-confirm"
          >
            <p className="text-xs">
              <Trans>
                Permanently deletes <code className="font-mono break-all">{targetGitPath}</code> and
                all its git history. Working files stay in place. If the parent git repo is
                intentional (e.g. you cloned it), cancel and pick a location outside it.
              </Trans>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={removeGitState.kind === 'pending'}
                onClick={() => onConfirmRemoveGit(gitRoot)}
                data-testid="create-banner-git-remove-confirm-button"
              >
                {removeGitState.kind === 'pending' ? (
                  <Trans>Removing</Trans>
                ) : (
                  <Trans>Delete {targetGitPath}</Trans>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={removeGitState.kind === 'pending'}
                onClick={onCancelRemoveGit}
                data-testid="create-banner-git-remove-cancel"
              >
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }
  const _exhaustive: never = cascade;
  void _exhaustive;
  return null;
}

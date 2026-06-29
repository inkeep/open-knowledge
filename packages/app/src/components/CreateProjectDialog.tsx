import {
  ALL_EDITOR_IDS,
  CREATE_NEW_PROJECT_FAILURE_REASONS,
  type CreateNewBannerKind,
  type CreateNewProjectFailureReason,
  EDITOR_LABELS,
  sanitizeFolderName,
} from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SharingModeField } from '@/components/SharingModeField';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
} from '@/lib/desktop-bridge-types';

const PROBE_DEBOUNCE_MS = 180;

const GIT_BANNER_POLL_INTERVAL_MS = 5_000;

type SettledCascade =
  | { kind: 'idle' }
  | { kind: 'block-nested'; rootPath: string }
  | { kind: 'confirm-git'; gitRoot: string }
  | { kind: 'block-nonempty' }
  | { kind: 'free' };

type ProbeLifecycle = 'idle' | 'in-flight';

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

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bridge: OkDesktopBridge;
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

export function CreateProjectDialog({ open, onOpenChange, bridge }: CreateProjectDialogProps) {
  const { t } = useLingui();
  const formId = useId();
  const nameInputId = useId();
  const captionId = useId();
  const nameErrorId = useId();
  const [location, setLocation] = useState('');
  const [locationResolving, setLocationResolving] = useState(false);
  const [name, setName] = useState('');
  const [editorIds, setEditorIds] = useState<ReadonlySet<OkMcpWiringEditorId>>(
    () => new Set(ALL_EDITOR_IDS),
  );
  const [sharing, setSharing] = useState<'shared' | 'local-only'>('shared');
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
  const removeGitCallIdRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    firedBanners.current.clear();
    setSubmitError(null);
    setCascade({ kind: 'idle' });
    setProbeLifecycle('idle');
    setBusy(false);
    setName('');
    setEditorIds(new Set(ALL_EDITOR_IDS));
    setSharing('shared');
    setAdvancedOpen(false);
    setRemoveGitState({ kind: 'idle' });
    removeGitCallIdRef.current += 1;

    let cancelled = false;
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

    const raf = requestAnimationFrame(() => {
      nameInputRef.current?.focus();
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [open, bridge]);

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
    probeLifecycle === 'idle' &&
    (cascade.kind === 'free' || cascade.kind === 'confirm-git');
  const submitDisabled = busy || (rawName !== '' && !canSubmit);

  function toggleEditor(id: OkMcpWiringEditorId) {
    setEditorIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
        editors: Array.from(editorIds),
        sharing,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChangeInternal}>
      <DialogContent className="sm:max-w-lg" data-testid="create-project-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Create new project</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Create a new OpenKnowledge project in the folder of your choice.</Trans>
          </DialogDescription>
        </DialogHeader>

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
                    A folder named <code className="font-mono break-all">{sanitized}</code> already
                    has files here. Pick a different name.
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
              {/* "Location" is a visual label for the read-only path display.
                  No htmlFor/association: the value sits in a non-labelable
                  <div> (a label can only bind to a form control), so a binding
                  here would be a dead attribute. AT reads the label then the
                  path in document order. The display is a <div>, not a shadcn
                  <Input readOnly>, because it renders three mutually exclusive
                  inner states (resolved path / "Resolving" / "No location
                  selected") that a single `value` string can't express. */}
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
                    Will be created at: <code className="font-mono break-all">{targetPreview}</code>
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

            <Collapsible
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
              className="rounded-md border border-border"
              data-testid="create-advanced"
            >
              <CollapsibleTrigger
                className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium hover:bg-muted/50"
                data-testid="create-advanced-trigger"
              >
                <Trans>Advanced settings</Trans>
                <ChevronRight
                  className="size-4 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                  aria-hidden
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-6 border-t border-border px-3 py-4">
                <fieldset className="flex flex-col space-y-2 pb-2">
                  <legend className="text-sm font-medium">
                    <Trans>Connect to AI tools</Trans>
                  </legend>
                  <p className="text-1sm text-muted-foreground">
                    <Trans>Each selected tool gets an OpenKnowledge MCP entry.</Trans>
                  </p>
                  {ALL_EDITOR_IDS.map((id) => {
                    const inputId = `create-editor-${id}`;
                    return (
                      <Label key={id} htmlFor={inputId} className="text-sm font-normal">
                        <Checkbox
                          id={inputId}
                          checked={editorIds.has(id)}
                          onCheckedChange={() => toggleEditor(id)}
                          disabled={busy}
                          data-testid={`create-editor-${id}`}
                        />
                        <span>{EDITOR_LABELS[id]}</span>
                      </Label>
                    );
                  })}
                </fieldset>

                <SharingModeField
                  idPrefix="create"
                  testIdPrefix="create-sharing"
                  value={sharing}
                  onValueChange={setSharing}
                  disabled={busy}
                />
              </CollapsibleContent>
            </Collapsible>

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

        <DialogFooter>
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
          <Button type="submit" form={formId} disabled={submitDisabled} data-testid="create-submit">
            {busy ? <Trans>Creating</Trans> : <Trans>Create</Trans>}
          </Button>
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

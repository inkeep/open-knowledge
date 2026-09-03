// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { receivesProjectIntegrationWrite } from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight } from 'lucide-react';
import type React from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { toast as sonnerToast } from 'sonner';
import { ProjectAiToolsField } from '@/components/ProjectAiToolsField';
import {
  DEFAULT_SHARING_MODE,
  type SharingMode,
  SharingModeField,
} from '@/components/SharingModeField';
import { Button } from '@/components/ui/button';
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
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { type ConsentStore, consentStore as defaultConsentStore } from '@/lib/consent-store';
import type {
  OkMcpWiringEditorId,
  OkOnboardingProbeContentResult,
  OkOnboardingShowPayload,
  OkOnboardingWarningKind,
} from '@/lib/desktop-bridge-types';
import { isContentDirSafe, relativeToProject } from '@/lib/project-paths';

const PROBE_THROTTLE_MS = 750;

/* STOP: this backstop must exceed the main-process detection ceiling, or it silently truncates
   working probes instead of catching wedged ones. That ceiling is the SLOWEST SINGLE LEG, and a
   leg is a SUM, not a max: detectProtocol races getApplicationInfoForProtocol against
   DEFAULT_PROBE_TIMEOUT_MS = 2000 (desktop/src/main/ipc-handlers.ts) and only THEN awaits the OS
   probe, which loops MACOS_APP_NAMES candidates SERIALLY at INSTALLED_AGENTS_PROBE_TIMEOUT_MS =
   2000 each (server/src/handoff-api.ts). One candidate per scheme today, so that leg is 4000; the
   CLI leg is PROBE_TIMEOUT_MS = 5000 (desktop/src/main/claude-readiness.ts) fanned out in
   parallel. Ceiling is 5000 and headroom is 3000. Three ways to breach it, none of which any test
   here catches because the grace-dependent tests inject a small detectionGraceMs: raise any of the
   three constants (2000 -> 6000 lands at exactly 8000), serialise a parallel fan-out, or add a
   third MACOS_APP_NAMES alias for one scheme (also exactly 8000, touching no constant named
   above). */
const DETECTION_GRACE_MS = 8_000;

const WARNING_COPY: Record<OkOnboardingWarningKind, MessageDescriptor> = {
  root: msg`You picked the filesystem root (/). Scaffolding here will scan every file on this machine — make sure that's what you want.`,
  home: msg`You picked your home directory. OpenKnowledge will index everything in your home tree — large and may surface personal files.`,
  'home-documents': msg`You picked ~/Documents. OpenKnowledge will index every markdown file under it. If you only want to manage a sub-folder, choose a smaller scope.`,
  'home-desktop': msg`You picked ~/Desktop. OpenKnowledge will index everything on your desktop.`,
  'home-downloads': msg`You picked ~/Downloads. Files there are usually transient — consider a stable folder instead.`,
  'volumes-mount': msg`This path is on an external volume (/Volumes/...). OpenKnowledge will lose track of files when the drive ejects.`,
  'drive-root': msg`This looks like a drive root (e.g., C:\\). Scaffolding here will scan an entire drive.`,
};

interface ConsentDialogBodyProps {
  store?: ConsentStore;
  toast?: ToastImpl;
  payload?: OkOnboardingShowPayload;
  detectionGraceMs?: number;
}

export interface ToastImpl {
  error(message: string): void;
}

const defaultToast: ToastImpl = {
  error: (message) => sonnerToast.error(message),
};

function ConsentDialogBody({
  store = defaultConsentStore,
  toast = defaultToast,
  payload,
  detectionGraceMs = DETECTION_GRACE_MS,
}: ConsentDialogBodyProps = {}) {
  const snapshot = payload ?? store.getSnapshot();
  if (!snapshot) return null;
  return (
    <ConsentDialogForm
      payload={snapshot}
      store={store}
      toast={toast}
      detectionGraceMs={detectionGraceMs}
    />
  );
}

interface ConsentDialogFormProps {
  payload: OkOnboardingShowPayload;
  store: ConsentStore;
  toast: ToastImpl;
  detectionGraceMs: number;
}

function ConsentDialogForm({ payload, store, toast, detectionGraceMs }: ConsentDialogFormProps) {
  const { t } = useLingui();
  const initGit = true;
  const formId = useId();
  const [contentDir, setContentDir] = useState(payload.defaultContentDir);
  const [additionalIgnores, setAdditionalIgnores] = useState('');
  const [detectedEditors, setDetectedEditors] = useState<readonly OkMcpWiringEditorId[] | null>(
    null,
  );
  const [connectEditors, setConnectEditors] = useState(true);
  const [sharing, setSharing] = useState<SharingMode>(DEFAULT_SHARING_MODE);
  const [probe, setProbe] = useState<OkOnboardingProbeContentResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [awaitingDetection, setAwaitingDetection] = useState(false);
  const detectionRef = useRef<Promise<readonly OkMcpWiringEditorId[]> | null>(null);
  const cancelInFlightRef = useRef(false);
  const confirmEpochRef = useRef(0);

  useEffect(() => {
    if (!isContentDirSafe(contentDir)) {
      setProbe(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      const bridge = window.okDesktop;
      if (!bridge) return;
      bridge.onboarding
        .probeContent({ contentDir })
        .then((result) => {
          if (!cancelled) setProbe(result);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            const message = err instanceof Error ? err.message : t`probe failed`;
            setProbe({ ok: false, error: message });
          }
        });
    }, PROBE_THROTTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [contentDir, t]);

  useEffect(() => {
    const bridge = window.okDesktop;
    if (!bridge) {
      setDetectedEditors([]);
      return;
    }
    let cancelled = false;
    const detection: Promise<readonly OkMcpWiringEditorId[]> = bridge.integrations
      .status()
      .then((status) => {
        const userMcpInstalled = new Set(
          status.editors.filter((e) => e.state === 'installed').map((e) => e.id),
        );
        return status.detectedEditorIds.filter((id) =>
          receivesProjectIntegrationWrite(id, {
            userMcpEntryInstalled: userMcpInstalled.has(id),
          }),
        );
      })
      .catch((err: unknown) => {
        console.warn('[ConsentDialog] editor-detection probe failed:', err);
        return [];
      });
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    detectionRef.current = Promise.race([
      detection,
      new Promise<readonly OkMcpWiringEditorId[]>((resolve) => {
        graceTimer = setTimeout(() => {
          console.warn(
            `[ConsentDialog] editor detection did not settle within ${detectionGraceMs}ms`,
          );
          if (!cancelled) setDetectedEditors([]);
          resolve([]);
        }, detectionGraceMs);
      }),
    ]);
    void detection.then((editors) => {
      clearTimeout(graceTimer);
      if (!cancelled) setDetectedEditors(editors);
    });
    return () => {
      cancelled = true;
      clearTimeout(graceTimer);
    };
  }, [detectionGraceMs]);

  const contentDirSafe = isContentDirSafe(contentDir);
  const startDisabled = busy || !contentDirSafe;
  const exitsLive = !busy || awaitingDetection;
  const advancedExpanded = advancedOpen || !contentDirSafe;

  const projectDir = payload.projectDir;
  const pickedRelative =
    relativeToProject(payload.projectDir, payload.pickedPath) ?? payload.pickedPath;

  async function onBrowseContentDir() {
    const bridge = window.okDesktop;
    if (!bridge) return;
    let picked: string | null;
    try {
      picked = await bridge.dialog.openFolder({ defaultPath: payload.projectDir });
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : t`Could not open folder picker`);
      return;
    }
    if (picked === null) return;
    const relative = relativeToProject(payload.projectDir, picked);
    if (relative === null) {
      setBrowseError(t`Selection must be inside the project`);
      return;
    }
    setBrowseError(null);
    setContentDir(relative);
  }

  async function resolveDetectedEditors(): Promise<readonly OkMcpWiringEditorId[]> {
    if (!connectEditors) return [];
    if (detectedEditors !== null) return detectedEditors;
    const pending = detectionRef.current;
    if (pending === null) return [];
    setAwaitingDetection(true);
    const detected = await pending;
    setAwaitingDetection(false);
    return detected;
  }

  async function onConfirm() {
    const epoch = confirmEpochRef.current + 1;
    confirmEpochRef.current = epoch;
    setBusy(true);
    const detected = await resolveDetectedEditors();
    if (confirmEpochRef.current !== epoch) return;
    const result = await store.confirm({
      initGit,
      contentDir,
      additionalIgnores,
      editorIds: [...detected],
      connectEditors,
      sharing,
    });
    if (!result.ok) {
      toast.error(result.error);
      setBusy(false);
    }
  }

  function onSubmit(e: React.SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    e.preventDefault();
    if (startDisabled) return;
    void onConfirm();
  }

  async function onCancel() {
    if (cancelInFlightRef.current) return;
    cancelInFlightRef.current = true;
    confirmEpochRef.current += 1;
    setBusy(true);
    const result = await store.cancel();
    if (!result.ok) {
      cancelInFlightRef.current = false;
      setAwaitingDetection(false);
      toast.error(result.error);
      setBusy(false);
    }
  }

  function onOpenChange(open: boolean) {
    if (!open && exitsLive) void onCancel();
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[role="radio"]')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Setup OpenKnowledge in this folder?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              OpenKnowledge stores its configuration and internal files inside a newly created{' '}
              <code>.ok</code> directory in your project root folder.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-6">
          {payload.gitRootPromoted ? (
            <p className="text-1sm text-muted-foreground">
              <Trans>
                OpenKnowledge initializes at <code>{projectDir}</code> — the parent of{' '}
                <code>{pickedRelative}</code> because it contains a <code>.git</code> folder (one
                .ok/ per git repo). <code>Content directory</code> defaults to <code>.</code> (the
                whole repo); type a sub-folder to narrow it.
              </Trans>
            </p>
          ) : null}

          {payload.warnings.length > 0 ? (
            <div
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
            >
              {payload.warnings.map((w) => (
                <p key={w.kind} className="mb-1 last:mb-0">
                  {t(WARNING_COPY[w.kind])}
                </p>
              ))}
            </div>
          ) : null}

          <form id={formId} onSubmit={onSubmit} data-testid="consent-form" className="space-y-6">
            {contentDirSafe ? <ProbePreview probe={probe} /> : null}

            {}
            <ProjectAiToolsField
              detectedEditors={detectedEditors}
              checked={connectEditors}
              onCheckedChange={setConnectEditors}
              disabled={busy}
              testIdPrefix="consent-editors"
              itemTestIdPrefix="consent-editor"
            />

            <SharingModeField
              idPrefix={formId}
              testIdPrefix="consent-sharing"
              value={sharing}
              onValueChange={setSharing}
              disabled={busy}
            />

            <Collapsible
              open={advancedExpanded}
              onOpenChange={setAdvancedOpen}
              className="rounded-md border border-border"
              data-testid="consent-advanced"
            >
              <CollapsibleTrigger
                className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium hover:bg-muted/50"
                data-testid="consent-advanced-trigger"
              >
                <Trans>Advanced settings</Trans>
                <ChevronRight
                  className="size-4 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                  aria-hidden
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-6 border-t border-border px-3 py-4">
                <div className="flex flex-col gap-2">
                  <label htmlFor="consent-content-dir" className="text-sm font-medium">
                    <Trans>Content directory</Trans>
                  </label>
                  <div className="flex items-stretch gap-2">
                    <Input
                      id="consent-content-dir"
                      value={contentDir}
                      onChange={(e) => {
                        setContentDir(e.target.value);
                        setBrowseError(null);
                      }}
                      disabled={busy}
                      aria-invalid={!contentDirSafe}
                      aria-describedby={
                        browseError !== null
                          ? 'consent-content-dir-browse-error'
                          : !contentDirSafe
                            ? 'consent-content-dir-error'
                            : undefined
                      }
                      data-testid="consent-content-dir"
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void onBrowseContentDir()}
                      data-testid="consent-content-dir-browse"
                    >
                      <Trans>Browse</Trans>
                    </Button>
                  </div>
                  {browseError !== null ? (
                    <p
                      id="consent-content-dir-browse-error"
                      className="text-1sm text-destructive"
                      data-testid="consent-content-dir-browse-error"
                    >
                      {browseError}
                    </p>
                  ) : !contentDirSafe ? (
                    <p
                      id="consent-content-dir-error"
                      className="text-1sm text-destructive"
                      data-testid="consent-content-dir-error"
                    >
                      <Trans>Content directory must be inside the project</Trans>
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-2">
                  <label htmlFor="consent-additional-ignores" className="text-sm font-medium">
                    <Trans>Ignore patterns</Trans>
                  </label>
                  <Textarea
                    id="consent-additional-ignores"
                    value={additionalIgnores}
                    onChange={(e) => setAdditionalIgnores(e.target.value)}
                    disabled={busy}
                    placeholder={'tmp/\n*.draft.md'}
                    rows={3}
                    data-testid="consent-additional-ignores"
                  />
                  <p className="text-1sm text-muted-foreground">
                    <Trans>
                      One pattern per line — appended to <code>.okignore</code>.
                    </Trans>
                  </p>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </form>
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => void onCancel()}
            disabled={!exitsLive}
            data-testid="consent-cancel"
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={startDisabled}
            aria-busy={awaitingDetection}
            data-testid="consent-start"
          >
            {awaitingDetection ? <Spinner aria-hidden="true" /> : null}
            <Trans comment="Primary button — begins scaffolding the project">Setup</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProbePreview({ probe }: { probe: OkOnboardingProbeContentResult | null }) {
  const { t } = useLingui();
  if (probe === null) {
    return (
      <p className="text-1sm text-muted-foreground" data-testid="consent-preview">
        <Trans>Counting markdown files</Trans>
      </p>
    );
  }
  if (!probe.ok) {
    const errorDetail = probe.error;
    return (
      <p className="text-1sm text-muted-foreground" data-testid="consent-preview">
        <Trans>Preview unavailable: {errorDetail}</Trans>
      </p>
    );
  }
  const countDisplay = probe.truncated ? '≥ 50,000' : String(probe.count);
  const countLine = t`Found ${countDisplay} markdown files`;
  if (probe.sample.length === 0) {
    return (
      <p className="text-1sm text-muted-foreground" data-testid="consent-preview">
        {countLine}
      </p>
    );
  }
  const remaining = probe.truncated ? null : probe.count - probe.sample.length;
  return (
    <Collapsible data-testid="consent-preview">
      <CollapsibleTrigger className="flex items-center gap-1 text-1sm text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-90">
        <ChevronRight
          className="size-3 transition-transform motion-reduce:transition-none"
          aria-hidden
        />
        <span>{countLine}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1 pl-4 text-1sm text-muted-foreground">
        <ul className="space-y-1.5 font-mono">
          {probe.sample.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
        {probe.truncated || (remaining !== null && remaining > 0) ? (
          <p className="mt-1 italic">
            {probe.truncated ? <Trans>and more</Trans> : <Trans>and {remaining} more</Trans>}
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

export default ConsentDialogBody;

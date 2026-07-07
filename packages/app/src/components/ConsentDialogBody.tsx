// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
/**
 * Per-project consent dialog implementation — split from
 * `ConsentDialog.tsx` so that file can lazy-load this module via
 * `React.lazy()`. See that file's header for the rationale.
 *
 * Reads as a confirmation screen: sensitive-path warning paragraphs
 * (role="alert"), git-root-promotion notice, a file-count preview line
 * (async + 750 ms throttle; cap surfaces as `≥ 50,000`), and the config-sharing
 * posture (side-by-side radio cards) stay visible, while the remaining editable
 * controls — content.dir text input with `..`-escape rejection + Browse button,
 * ignore-patterns textarea, and AI-tool multi-select (all checked by default,
 * no auto-detect) — collapse into an "Advanced settings" section (force-opened
 * when content.dir is invalid so its inline error stays reachable). Start
 * primary + Cancel secondary. Picking a
 * folder via
 * the dialog == agreeing to scaffold `.ok/`; users who don't want OK
 * scaffolded simply Cancel. Git is initialized implicitly when the
 * picked path has no real `.git/` (or is shell-only) — no UI toggle.
 */

import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight } from 'lucide-react';
import type React from 'react';
import { useEffect, useId, useState } from 'react';
import { toast as sonnerToast } from 'sonner';
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

// Module-level constants can't use the `t` macro — `msg` produces lazy
// MessageDescriptors resolved per-render via `useLingui()._`.
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
  /** Test-only override for the payload — production reads from `store`. */
  payload?: OkOnboardingShowPayload;
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
}: ConsentDialogBodyProps = {}) {
  const snapshot = payload ?? store.getSnapshot();
  if (!snapshot) return null;
  return <ConsentDialogForm payload={snapshot} store={store} toast={toast} />;
}

interface ConsentDialogFormProps {
  payload: OkOnboardingShowPayload;
  store: ConsentStore;
  toast: ToastImpl;
}

/** Dialog form — local state, async file-count probe, validation. */
function ConsentDialogForm({ payload, store, toast }: ConsentDialogFormProps) {
  const { t } = useLingui();
  // Initialize-git-repo behavior is implicit: main runs `ensureProjectGit`
  // whenever gitState is 'absent' or 'shell-only', matching the
  // create-new-project IPC handler. The IPC payload still carries
  // `initGit: true` so re-introducing a UI toggle later is a one-file
  // change.
  const initGit = true;
  const formId = useId();
  const [contentDir, setContentDir] = useState(payload.defaultContentDir);
  const [additionalIgnores, setAdditionalIgnores] = useState('');
  const [editorIds, setEditorIds] = useState<ReadonlySet<OkMcpWiringEditorId>>(
    () => new Set(payload.editorOptions.map((e) => e.id)),
  );
  // Sharing-mode posture. Default `'shared'`: encourages team adoption.
  const [sharing, setSharing] = useState<'shared' | 'local-only'>('shared');
  const [probe, setProbe] = useState<OkOnboardingProbeContentResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Throttled probe: 750 ms after the last contentDir edit. Probe runs
  // asynchronously through the bridge — main caps the walk at 50,000
  // entries and yields to setImmediate so the IPC reply doesn't block the
  // main loop on huge trees.
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

  const contentDirSafe = isContentDirSafe(contentDir);
  const startDisabled = busy || !contentDirSafe;
  // Advanced settings collapse by default — the dialog reads as a
  // confirmation screen. Force it open whenever the content dir is invalid
  // so the inline error (which lives inside the section) can't hide off-screen.
  const advancedExpanded = advancedOpen || !contentDirSafe;

  // Named locals so the git-root-promoted `<Trans>` extracts meaningful
  // placeholder names (`{projectDir}` / `{pickedRelative}`) instead of the
  // positional `{0}` / `{1}` a member expression would yield.
  const projectDir = payload.projectDir;
  const pickedRelative =
    relativeToProject(payload.projectDir, payload.pickedPath) ?? payload.pickedPath;

  function toggleEditor(id: OkMcpWiringEditorId) {
    setEditorIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  async function onConfirm() {
    setBusy(true);
    const result = await store.confirm({
      initGit,
      contentDir,
      additionalIgnores,
      editorIds: Array.from(editorIds),
      sharing,
    });
    if (!result.ok) {
      toast.error(result.error);
      setBusy(false);
    }
  }

  // Enter-on-any-field fires Start. The form wraps just the input fields
  // inside DialogBody so DialogHeader / DialogBody / DialogFooter remain
  // direct flex children of DialogContent (preserving its `gap-6` between
  // sections). The Start button in the footer binds back via the HTML
  // `form` attribute. Cancel is type="button" so it doesn't submit. Suppress
  // the default form submission (page reload in a renderer) and route
  // through the same Start path.
  function onSubmit(e: React.SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    e.preventDefault();
    if (startDisabled) return;
    void onConfirm();
  }

  async function onCancel() {
    setBusy(true);
    const result = await store.cancel();
    if (!result.ok) {
      toast.error(result.error);
      setBusy(false);
    }
  }

  function onOpenChange(open: boolean) {
    if (!open && !busy) void onCancel();
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        // Radix Dialog autofocuses the first focusable descendant on open. The
        // file-count probe is async, so ProbePreview renders a non-focusable
        // placeholder at mount — making the sharing-info TooltipTrigger the
        // first focusable element. A Radix Tooltip opens immediately on focus
        // (delayDuration 0), so the info popover would pop open unbidden.
        // Redirect initial focus to the primary control (the first sharing
        // radio); keyboard users still get the tooltip on a later Tab to it.
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

                <fieldset className="flex flex-col space-y-2 pb-2">
                  <legend className="text-sm font-medium">
                    <Trans>Connect to AI tools</Trans>
                  </legend>
                  <p className="text-1sm text-muted-foreground">
                    <Trans>
                      Writes a project-MCP config for each selected tool; Claude also gets{' '}
                      <code>.claude/launch.json</code>.
                    </Trans>
                  </p>
                  {payload.editorOptions.map((editor) => {
                    const checkboxId = `consent-editor-${editor.id}-cb`;
                    return (
                      <label
                        key={editor.id}
                        htmlFor={checkboxId}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={editorIds.has(editor.id)}
                          onCheckedChange={() => toggleEditor(editor.id)}
                          disabled={busy}
                          data-testid={`consent-editor-${editor.id}`}
                        />
                        <span>{editor.label}</span>
                        <span
                          className="text-xs text-muted-foreground"
                          data-testid={`consent-editor-${editor.id}-scope`}
                        >
                          {editor.hasProjectConfig ? (
                            <Trans comment="Scope tag next to an AI tool — config is written at both project and user level">
                              (project + user)
                            </Trans>
                          ) : (
                            <Trans comment="Scope tag next to an AI tool — config is written at user level only">
                              (user-level only)
                            </Trans>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              </CollapsibleContent>
            </Collapsible>
          </form>
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="font-mono uppercase"
            onClick={() => void onCancel()}
            disabled={busy}
            data-testid="consent-cancel"
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" form={formId} disabled={startDisabled} data-testid="consent-start">
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

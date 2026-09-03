// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { i18n } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useTheme } from 'next-themes';
import { type ComponentType, type ReactNode, useId, useState, useSyncExternalStore } from 'react';
import { toast as sonnerToast } from 'sonner';
import { OkIcon } from '@/components/icons/ok';
import { RowDisclosure } from '@/components/RowDisclosure';
import { narrowThemePreference, ThemePicker, type ThemePreference } from '@/components/ThemePicker';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useConfigContextOptional } from '@/lib/config-context';
import type { OkMcpWiringShowPayload } from '@/lib/desktop-bridge-types';
import { type McpConsentStore, mcpConsentStore } from '@/lib/mcp-consent-store';
import { formatToolList } from '@/lib/tool-list-format';
import { cn } from '@/lib/utils';

type EditorDetection = OkMcpWiringShowPayload['detectedEditors'][number];
type PathInstallDescriptor = OkMcpWiringShowPayload['pathInstall'];

const SUBTEXT = 'text-1sm leading-normal';
const ROW_SUBTEXT = `${SUBTEXT} ps-6.5 text-muted-foreground`;
const ROW_WARNING = `${SUBTEXT} ps-6.5 text-amber-700 dark:text-amber-400`;
const SECTION_SUBTEXT = `${SUBTEXT} text-muted-foreground`;

export function isPathRowActionable(pathInstall: PathInstallDescriptor): boolean {
  return pathInstall.shellDetected && !pathInstall.alreadyInstalled;
}

export function connectableEditors(
  editors: readonly EditorDetection[],
): readonly EditorDetection[] {
  return editors.filter((e) => e.detected);
}

interface ConsentSurface {
  Root: ComponentType<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }>;
  Content: ComponentType<{ className?: string; 'aria-busy'?: boolean; children: ReactNode }>;
  Header: ComponentType<{ children: ReactNode }>;
  Title: ComponentType<{ className?: string; children: ReactNode }>;
  Description: ComponentType<{ className?: string; children: ReactNode }>;
  Body: ComponentType<{ className?: string; children: ReactNode }>;
  Footer: ComponentType<{ className?: string; children: ReactNode }>;
}

const FIRST_RUN_SURFACE: ConsentSurface = {
  Root: AlertDialog,
  Content: AlertDialogContent,
  Header: AlertDialogHeader,
  Title: AlertDialogTitle,
  Description: AlertDialogDescription,
  Body: AlertDialogBody,
  Footer: AlertDialogFooter,
};

const DISMISSIBLE_SURFACE: ConsentSurface = {
  Root: Dialog,
  Content: DialogContent,
  Header: DialogHeader,
  Title: DialogTitle,
  Description: DialogDescription,
  Body: DialogBody,
  Footer: DialogFooter,
};

export interface McpConsentDialogBodyProps {
  store?: McpConsentStore;
  toast?: ToastImpl;
  payload?: OkMcpWiringShowPayload;
}

export interface ToastImpl {
  error(message: string): void;
  message(message: string): void;
}

const defaultToast: ToastImpl = {
  error: (message) => sonnerToast.error(message),
  message: (message) => sonnerToast.message(message),
};

export function McpConsentDialogBody({
  store = mcpConsentStore,
  toast = defaultToast,
  payload,
}: McpConsentDialogBodyProps = {}) {
  const subscribed = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
  const snapshot = payload ?? subscribed;

  const [seenSnapshot, setSeenSnapshot] = useState(snapshot);
  const [requestKey, setRequestKey] = useState(0);
  if (snapshot !== seenSnapshot) {
    setSeenSnapshot(snapshot);
    if (snapshot !== null) setRequestKey((n) => n + 1);
  }

  if (!snapshot) return null;
  return <McpConsentDialogForm key={requestKey} payload={snapshot} store={store} toast={toast} />;
}

interface McpConsentDialogFormProps {
  payload: OkMcpWiringShowPayload;
  store: McpConsentStore;
  toast: ToastImpl;
}

function McpConsentDialogForm({ payload, store, toast }: McpConsentDialogFormProps) {
  const { t } = useLingui();
  const pathInstall = payload.pathInstall;
  const globalSkills = payload.globalSkills;
  const skillsOffered = globalSkills.some((skill) => skill.paths.length > 0);
  const pathActionable = isPathRowActionable(pathInstall);
  const ptyAvailable = window.okDesktop?.config.ptyAvailable === true;
  const editors = connectableEditors(payload.detectedEditors);
  const hasEditors = editors.length > 0;
  const replacing = editors.filter((e) => e.willReplace);
  const replacingAll = replacing.length > 0 && replacing.length === editors.length;
  const connectToolList = formatToolList(
    editors.map((e) => e.label),
    i18n.locale,
  );
  const [connectChecked, setConnectChecked] = useState(true);
  const [skillsChecked, setSkillsChecked] = useState(true);
  const [pathChecked, setPathChecked] = useState(true);
  const { theme, setTheme } = useTheme();
  const themePreference = narrowThemePreference(theme);
  const configContext = useConfigContextOptional();

  function commitTheme(next: ThemePreference): void {
    setTheme(next);
    const binding = configContext?.userBinding;
    if (!binding) return;
    const result = binding.patch({ appearance: { theme: next } });
    if (!result.ok) {
      toast.error(t`Couldn't save your theme preference.`);
    }
  }
  const [busy, setBusy] = useState(false);
  const idPrefix = useId();
  const showReplaceWarning = connectChecked && replacing.length > 0;

  async function onContinue() {
    setBusy(true);
    const connecting = connectChecked && hasEditors;
    const result = await store.confirm({
      editorIds: connecting ? editors.map((e) => e.id) : [],
      pathInstall: pathActionable ? pathChecked : undefined,
      skills: skillsChecked && skillsOffered ? globalSkills.map((s) => s.id) : undefined,
    });
    if (!result.ok) {
      toast.error(result.error);
      setBusy(false);
      return;
    }
    if (!connecting) {
      toast.message(t`This can be configured in Settings > AI tools & CLI`);
    }
  }

  const firstRun = payload.origin === 'first-run';
  const Surface = firstRun ? FIRST_RUN_SURFACE : DISMISSIBLE_SURFACE;

  function onDismiss(): void {
    store.dismiss();
  }

  async function onSkip() {
    setBusy(true);
    const result = await store.skip();
    if (result.ok) {
      toast.message(t`This can be configured in Settings > AI tools & CLI`);
    } else {
      toast.error(result.error);
      setBusy(false);
    }
  }

  function onOpenChange(open: boolean) {
    if (open || busy) return;
    if (firstRun) void onSkip();
    else onDismiss();
  }

  return (
    <Surface.Root open onOpenChange={onOpenChange}>
      {}
      <Surface.Content
        className={cn(
          'sm:max-w-2xl md:max-w-3xl',
          busy &&
            '[&_[data-slot=dialog-close]]:pointer-events-none [&_[data-slot=dialog-close]]:opacity-50',
        )}
        aria-busy={busy}
      >
        <Surface.Header>
          <Surface.Title className="flex flex-col gap-8 text-2xl tracking-tighter">
            {}
            <OkIcon className="size-10 shrink-0" aria-hidden />
            {}
            <span className="flex flex-col gap-1.5">
              <span className="uppercase font-mono font-normal text-2xs text-muted-foreground tracking-widest">
                <Trans>Welcome to OpenKnowledge</Trans>
              </span>
              <Trans>Let's get set up.</Trans>
            </span>
          </Surface.Title>
          <Surface.Description className="sr-only">
            <Trans>Customize your OpenKnowledge experience.</Trans>
          </Surface.Description>
        </Surface.Header>

        <Surface.Body className="flex flex-col gap-6 min-h-0">
          {}
          {pathInstall.shellDetected && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium text-foreground">
                <Trans comment="Section label above the shell-PATH toggle in the first-launch dialog">
                  Terminal
                </Trans>
              </h3>
              {}
              <div
                className={cn(
                  'relative overflow-hidden rounded-lg border border-border bg-card/50 px-4 py-3',
                  pathActionable && 'hover:bg-accent',
                )}
              >
                <Label
                  htmlFor={`${idPrefix}-path`}
                  className={
                    pathActionable
                      ? 'flex min-w-0 cursor-pointer flex-col items-start gap-1 font-normal'
                      : 'flex min-w-0 flex-col items-start gap-1 font-normal'
                  }
                >
                  {}
                  <span className="flex w-full items-center gap-2.5">
                    <Checkbox
                      id={`${idPrefix}-path`}
                      checked={pathActionable ? pathChecked : true}
                      disabled={busy || !pathActionable}
                      onCheckedChange={() => setPathChecked((prev) => !prev)}
                      data-testid="mcp-consent-path-checkbox"
                    />
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 pe-28 text-sm font-medium text-foreground">
                      <Trans comment="Toggle in the first-launch dialog that adds the ok CLI to the user's shell PATH">
                        Add the <code className="inline-code text-1sm!">ok</code> command to your
                        terminal
                      </Trans>
                    </span>
                  </span>
                  {pathActionable && (
                    <span className={ROW_SUBTEXT}>
                      <Trans comment="Subtext under the terminal toggle explaining what the ok command gives you">
                        Launch OpenKnowledge from any terminal —{' '}
                        <code className="inline-code text-xs!">ok</code> opens a project,{' '}
                        <code className="inline-code text-xs!">ok init</code> connects your agents.
                      </Trans>
                    </span>
                  )}
                  {!pathActionable && (
                    <span className={ROW_SUBTEXT} data-testid="mcp-consent-path-status">
                      {t`Already set up — ok is available in your terminal`}
                    </span>
                  )}
                  {pathActionable && !pathChecked && (
                    <span className={ROW_WARNING} data-testid="mcp-consent-path-warning">
                      {ptyAvailable ? (
                        <Trans comment="Warning shown when the user unchecks the PATH toggle on a desktop build with the built-in terminal">
                          <code className="inline-code text-xs!">ok</code> won't run in external
                          terminals until you add it later from the File menu. OpenKnowledge's
                          built-in terminal and AI tools keep working.
                        </Trans>
                      ) : (
                        <Trans comment="Warning shown when the user unchecks the PATH toggle on a desktop build without the built-in terminal">
                          <code className="inline-code text-xs!">ok</code> won't run in external
                          terminals until you add it later from the File menu. Your AI tools keep
                          working.
                        </Trans>
                      )}
                    </span>
                  )}
                </Label>
                {pathActionable && (
                  <RowDisclosure title={t`Adds a managed block to`} testId="mcp-consent-path-info">
                    <span className="wrap-break-word" data-testid="mcp-consent-path-status">
                      {pathInstall.rcFilesToTouch.map((file) => (
                        <span key={file} className="block">
                          <code className="break-all">{file}</code>
                        </span>
                      ))}
                    </span>
                  </RowDisclosure>
                )}
              </div>
            </div>
          )}

          {}
          {(hasEditors || skillsOffered) && (
            <>
              {}
              <div className="flex flex-col gap-1.5">
                <h3 className="text-sm font-medium text-foreground">
                  <Trans comment="Section label above the AI-tools checkboxes in the first-launch dialog">
                    Connect your AI tools
                  </Trans>
                </h3>
                {}
                {hasEditors ? (
                  <p className={cn(SECTION_SUBTEXT, 'mb-1')}>
                    <Trans comment="Description under the AI-tools section label in the first-launch dialog">
                      Globally install the OpenKnowledge skills and MCP to let the agents you
                      already use read and update your projects.
                    </Trans>
                  </p>
                ) : null}
                <div className="flex flex-col gap-2">
                  {hasEditors ? (
                    <div className="relative overflow-hidden rounded-lg border border-border bg-card/50 px-4 py-3 hover:bg-accent">
                      <Label
                        htmlFor={`${idPrefix}-connect`}
                        className="flex min-w-0 cursor-pointer flex-col items-start gap-1 font-normal"
                      >
                        <span className="flex w-full items-center gap-2.5">
                          <Checkbox
                            id={`${idPrefix}-connect`}
                            checked={connectChecked}
                            disabled={busy}
                            onCheckedChange={() => setConnectChecked((prev) => !prev)}
                            data-testid="mcp-consent-connect-checkbox"
                          />
                          <span
                            className="flex min-w-0 flex-1 items-center gap-1.5 pe-28 text-sm font-medium text-foreground"
                            data-testid="mcp-consent-connect-summary"
                          >
                            <Trans comment="Checkbox that wires the OpenKnowledge MCP into every detected AI tool">
                              Install OpenKnowledge in your AI tools
                            </Trans>
                          </span>
                        </span>
                        {}
                        <span className={ROW_SUBTEXT}>
                          {}
                          <Trans comment="Subtext under the AI-tools MCP checkbox">
                            Adds an OpenKnowledge MCP entry to{' '}
                            <span className="font-medium text-foreground">{connectToolList}</span>,
                            so your agents can read and edit your files.
                          </Trans>
                        </span>
                        {}
                        {showReplaceWarning && (
                          <span
                            className={ROW_WARNING}
                            data-testid="mcp-consent-connect-replace-warning"
                          >
                            {}
                            {replacingAll
                              ? t`Replaces the OpenKnowledge entry each of them already has.`
                              : t`Replaces the existing OpenKnowledge entry in ${formatToolList(
                                  replacing.map((e) => e.label),
                                  i18n.locale,
                                )}`}
                          </span>
                        )}
                      </Label>
                      <RowDisclosure
                        title={t`Writes an entry to`}
                        testId="mcp-consent-connect-info"
                      >
                        <span
                          className="flex flex-col gap-2"
                          data-testid="mcp-consent-connect-details"
                        >
                          {editors.map((editor) => (
                            <span key={editor.id} className="flex min-w-0 flex-col">
                              <span className="font-medium">{editor.label}</span>
                              <span className="wrap-break-word opacity-75">
                                <code className="break-all">
                                  {editor.configPath ?? t`unavailable on this platform`}
                                </code>
                              </span>
                            </span>
                          ))}
                        </span>
                      </RowDisclosure>
                    </div>
                  ) : null}

                  {}
                  {skillsOffered && (
                    <div className="relative overflow-hidden rounded-lg border border-border bg-card/50 px-4 py-3 hover:bg-accent">
                      <Label
                        htmlFor={`${idPrefix}-skills`}
                        className="flex min-w-0 cursor-pointer flex-col items-start gap-1 font-normal"
                      >
                        <span className="flex w-full items-center gap-2.5">
                          <Checkbox
                            id={`${idPrefix}-skills`}
                            checked={skillsChecked}
                            disabled={busy}
                            onCheckedChange={() => setSkillsChecked((prev) => !prev)}
                            data-testid="mcp-consent-skill-checkbox"
                          />
                          <span className="flex min-w-0 flex-1 items-center gap-1.5 pe-28 text-sm font-medium text-foreground">
                            <Trans comment="Checkbox that installs the user-global discovery skill bundle">
                              Install the{' '}
                              <code className="inline-code text-1sm!">
                                open-knowledge-discovery
                              </code>{' '}
                              skill
                            </Trans>
                          </span>
                        </span>
                        <span className={ROW_SUBTEXT}>
                          <Trans comment="Subtext under the discovery-skill checkbox">
                            Help your agents discover and use OpenKnowledge in any project.
                          </Trans>
                        </span>
                      </Label>
                      <RowDisclosure title={t`Adds these folders`} testId="mcp-consent-skill-info">
                        <span
                          className="flex flex-col gap-2"
                          data-testid="mcp-consent-skill-details"
                        >
                          {globalSkills.map((skill) => (
                            <span key={skill.id} className="flex min-w-0 flex-col gap-0.5">
                              {globalSkills.length > 1 && (
                                <span className="font-medium">{skill.name}</span>
                              )}
                              {skill.paths.map((path) => (
                                <span key={path} className="wrap-break-word opacity-75">
                                  <code className="break-all">{path}</code>
                                </span>
                              ))}
                            </span>
                          ))}
                        </span>
                      </RowDisclosure>
                    </div>
                  )}

                  {}
                  {!hasEditors && (
                    <p className={SECTION_SUBTEXT} data-testid="mcp-consent-no-tools">
                      <Trans comment="Shown in place of the AI-tools checkbox when no AI tool was detected">
                        No AI tools detected yet. Once you install one, connect it from Settings
                        &gt; AI tools & CLI.
                      </Trans>
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
          {}
          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium text-foreground">
              <Trans comment="Section label above the light/dark/system cards in the first-launch dialog">
                Choose your theme
              </Trans>
            </h3>
            <ThemePicker
              value={themePreference}
              onValueChange={commitTheme}
              disabled={busy}
              aria-label={t`Choose your theme`}
            />
          </div>
        </Surface.Body>
        <Surface.Footer className="sm:justify-between">
          {}
          {}
          {firstRun ? (
            <AlertDialogCancel
              variant="link-muted"
              disabled={busy}
              className="-ms-2.5 tracking-wide"
              data-testid="mcp-consent-skip"
            >
              <Trans comment="Secondary footer action that dismisses first-launch setup without writing any config">
                Skip for now
              </Trans>
            </AlertDialogCancel>
          ) : (
            <Button
              variant="link-muted"
              disabled={busy}
              className="-ms-2.5 tracking-wide"
              data-testid="mcp-consent-skip"
              onClick={onDismiss}
            >
              {}
              <Trans>Cancel</Trans>
            </Button>
          )}
          {}
          <Button onClick={() => void onContinue()} disabled={busy} data-testid="mcp-consent-add">
            {busy ? (
              <Trans>Working</Trans>
            ) : (
              <Trans comment="Primary button that applies the first-launch setup choices">
                Finish setup
              </Trans>
            )}
          </Button>
        </Surface.Footer>
      </Surface.Content>
    </Surface.Root>
  );
}

export default McpConsentDialogBody;

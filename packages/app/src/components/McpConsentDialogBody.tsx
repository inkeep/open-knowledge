/**
 * Consent dialog implementation — split out from `McpConsentDialog.tsx`
 * so that file can lazy-load this module via `React.lazy()`. See that file's
 * header for the why.
 *
 * One decision per independent consequence, and no more. The AI-tool setup is a
 * SINGLE pre-checked checkbox covering every detected tool plus the user-global
 * discovery skill, because those are one thought ("let my agents see this") and
 * splitting them made a first-run screen the user had to audit row by row.
 * Per-tool granularity lives in Settings → AI tools & CLI, where it can be
 * revisited; here it would only slow down the common answer.
 *
 * The shell-PATH install stays its own checkbox: MCP runs over npx / the bundle
 * wrapper and never over bare `ok`, so wanting one says nothing about wanting
 * the other.
 *
 * Consent integrity — this dialog fires once, so it must disclose exactly what
 * it will touch:
 *   - The checkbox label NAMES every tool in the write set, collapsed or not.
 *   - A replacement warning sits next to the checkbox, never behind the
 *     expander, so an overwrite is never something the user had to go looking
 *     for.
 *   - "What this changes" lists the exact files, entries and skill destinations.
 *     Every path comes from main's descriptors, which are computed from the
 *     installer's own iteration set and gates — never re-derived here.
 *
 * Undetected tools are absent entirely: a row that writes nothing is noise on a
 * first-run screen, and Settings lists them all.
 *
 * The screen only ever ADDS. Leaving the box unchecked records no skill decision
 * (`skills: undefined`, which main reads as "no decision" rather than "decline
 * all"), so dismissing setup can never tear down a bundle already on disk.
 * Removal is Settings' job, where the row states what it removes.
 */

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { i18n } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronUp, Info } from 'lucide-react';
import { useId, useState } from 'react';
import { toast as sonnerToast } from 'sonner';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { OkMcpWiringShowPayload } from '@/lib/desktop-bridge-types';
import { type McpConsentStore, mcpConsentStore } from '@/lib/mcp-consent-store';
import { formatToolList } from '@/lib/tool-list-format';

type EditorDetection = OkMcpWiringShowPayload['detectedEditors'][number];
type PathInstallDescriptor = OkMcpWiringShowPayload['pathInstall'];

/**
 * Pure helper: whether the PATH row solicits a decision. Hidden rows
 * (`shellDetected: false`) and informational rows (`alreadyInstalled`)
 * send `pathInstall: undefined` on confirm — no decision was asked, so the
 * path-install marker must not be touched.
 */
export function isPathRowActionable(pathInstall: PathInstallDescriptor): boolean {
  return pathInstall.shellDetected && !pathInstall.alreadyInstalled;
}

/**
 * Pure helper: the write set. Detected tools only, in payload order — an
 * undetected tool has no config to wire, so including it would name a
 * destination nothing is written to.
 */
export function connectableEditors(
  editors: readonly EditorDetection[],
): readonly EditorDetection[] {
  return editors.filter((e) => e.detected);
}

/**
 * Test-injectable store + toast — production consumers use the default
 * exports. Exposed as props so `bun test` doesn't need to reset module
 * singletons OR mock the global `sonner` import.
 */
export interface McpConsentDialogBodyProps {
  store?: McpConsentStore;
  toast?: ToastImpl;
  /**
   * Explicit payload, for tests that exercise dialog behavior without going
   * through `mcpConsentStore`. Production renders default this from the
   * store; when null (store has no current request) the component returns
   * null and nothing mounts.
   */
  payload?: OkMcpWiringShowPayload;
}

/** Minimal `sonner` surface the dialog uses. */
export interface ToastImpl {
  error(message: string): void;
  message(message: string): void;
}

const defaultToast: ToastImpl = {
  error: (message) => sonnerToast.error(message),
  message: (message) => sonnerToast.message(message),
};

/**
 * Inner dialog body — stateful, does the confirm/skip flow. The outer
 * `McpConsentDialog` in the sibling file handles the lazy-load gate; by the
 * time we're mounted, the store is guaranteed to have a payload (or an
 * explicit test override was passed).
 */
export function McpConsentDialogBody({
  store = mcpConsentStore,
  toast = defaultToast,
  payload,
}: McpConsentDialogBodyProps = {}) {
  // In production the lazy wrapper only mounts us when the snapshot is non-
  // null; we still read from the store here so React subscribes (and we
  // unmount cleanly when clearCurrent fires on success). The `payload` prop
  // override is test-only.
  const snapshot = payload ?? store.getSnapshot();
  if (!snapshot) return null;
  return <McpConsentDialogForm payload={snapshot} store={store} toast={toast} />;
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
  const skillsOffered = globalSkills.length > 0;
  const pathActionable = isPathRowActionable(pathInstall);
  const ptyAvailable = window.okDesktop?.config.ptyAvailable === true;
  const editors = connectableEditors(payload.detectedEditors);
  const hasEditors = editors.length > 0;
  const replacing = editors.filter((e) => e.willReplace);
  // Pre-checked (opt-out): the common answer is yes, and the label names
  // everything it covers so agreeing isn't agreeing blind.
  const [connectChecked, setConnectChecked] = useState(true);
  // Pre-checked (opt-out) when the row solicits a decision; informational
  // rows render force-checked + disabled below and never read this state.
  const [pathChecked, setPathChecked] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const idPrefix = useId();

  async function onContinue() {
    setBusy(true);
    const connecting = connectChecked && hasEditors;
    const result = await store.confirm({
      editorIds: connecting ? editors.map((e) => e.id) : [],
      pathInstall: pathActionable ? pathChecked : undefined,
      // An array records a decision for every offered bundle; `undefined` records
      // none. Declining setup must leave an existing install alone, so the
      // decline path sends `undefined`, never `[]`.
      skills: connecting && skillsOffered ? globalSkills.map((s) => s.id) : undefined,
    });
    // Success: the store clears `currentRequest` → useSyncExternalStore
    // unmounts this subtree, so there's nothing to reset. Failure
    // (ok:false / thrown rejection): the store KEEPS the snapshot
    // populated, so we must reset `busy` here or the button stays disabled
    // forever and same-boot retry is impossible. Sonner is mounted globally
    // in main.tsx; the toast surfaces even if the dialog were to unmount.
    if (!result.ok) {
      toast.error(result.error);
      setBusy(false);
      return;
    }
    // Continuing without connecting anything is a legitimate choice, but the
    // dialog is one-shot — without this the surface is easy to lose track of.
    if (!connecting) {
      toast.message(t`This can be configured in Settings > AI tools & CLI`);
    }
  }

  async function onSkip() {
    setBusy(true);
    const result = await store.skip();
    if (result.ok) {
      toast.message(t`This can be configured in Settings > AI tools & CLI`);
    } else {
      toast.error(result.error);
      // Matching rationale to onContinue — reset `busy` so the dialog stays
      // usable after a transient marker-write failure.
      setBusy(false);
    }
  }

  function onOpenChange(open: boolean) {
    // ESC, outside-click, X button — no decision was made, so this is a skip
    // (marker only), not a decline.
    if (!open && !busy) void onSkip();
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      {/*
       * Radix Dialog auto-wires `aria-labelledby` / `aria-describedby` on
       * `DialogContent` from `DialogTitle` / `DialogDescription` via context
       * — no manual `useId` plumbing needed. Each row's `<Label>` is
       * associated to its `<Checkbox>` by `htmlFor` + matching `id`,
       * providing the accessible name; no `aria-describedby` on the checkbox
       * itself, since duplicating the label content via that attr causes
       * screen readers to either announce the label twice or drop the
       * association.
       */}
      <DialogContent className="sm:max-w-lg" aria-busy={busy}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Connect your AI tools to OpenKnowledge</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Give the AI tools you use access to read and update your projects. You can change any
              of this later in Settings &gt; AI tools & CLI.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-6 min-h-0">
          {/*
           * Shell-PATH consent section — rendered first inside the scrollable
           * DialogBody, above the AI-tools row. Distinct from the AI-tools
           * checkbox because the two decisions are independent (MCP runs over
           * npx / the bundle wrapper, never bare `ok`). Hidden when no rc file
           * is touchable; informational when a managed block is already on disk
           * or consent was already granted.
           */}
          {pathInstall.shellDetected && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                <Trans comment="Section label above the shell-PATH toggle in the first-launch dialog">
                  Terminal
                </Trans>
              </span>
              <div className="overflow-hidden rounded-md border border-border bg-card/50">
                <Label
                  htmlFor={`${idPrefix}-path`}
                  // items-start overrides the shadcn Label base `items-center`,
                  // which on a flex column would center every child horizontally.
                  className={
                    pathActionable
                      ? 'flex cursor-pointer flex-col items-start gap-1 px-3 py-2.5 font-normal hover:bg-accent'
                      : 'flex flex-col items-start gap-1 px-3 py-2.5 font-normal'
                  }
                >
                  {/* Checkbox centered against the title line only (not the whole
                    column) so the `ok` code chip — taller than plain text — can't
                    push it out of alignment. Subtexts sit below, indented to align
                    under the title (checkbox size-4 = 1rem + gap-2.5 = 0.625rem). */}
                  <span className="flex items-center gap-2.5">
                    <Checkbox
                      id={`${idPrefix}-path`}
                      checked={pathActionable ? pathChecked : true}
                      disabled={busy || !pathActionable}
                      onCheckedChange={() => setPathChecked((prev) => !prev)}
                      data-testid="mcp-consent-path-checkbox"
                    />
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-foreground">
                      <Trans comment="Toggle in the first-launch dialog that adds the ok CLI to the user's shell PATH">
                        Add the <code className="inline-code">ok</code> command to your terminal
                      </Trans>
                      {pathActionable && (
                        <Tooltip>
                          {/* Relies on the root TooltipProvider (main.tsx) so every
                            info button in this dialog shares one skip-delay window.
                            Nested inside the row <Label>, so stop the click from
                            bubbling to toggle the checkbox; Radix opens on
                            hover/focus (not click), so preventing the click default
                            costs nothing. */}
                          <TooltipTrigger
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={t`What this changes`}
                            data-testid="mcp-consent-path-info"
                          >
                            <Info className="size-3.5" aria-hidden />
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p
                              className="leading-relaxed wrap-break-word"
                              data-testid="mcp-consent-path-status"
                            >
                              {t`Adds a managed block to ${pathInstall.rcFilesToTouch.join(', ')}`}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                  </span>
                  {!pathActionable && (
                    <span
                      className="ps-6.5 text-xs text-muted-foreground"
                      data-testid="mcp-consent-path-status"
                    >
                      {t`Already set up — ok is available in your terminal`}
                    </span>
                  )}
                  {pathActionable && !pathChecked && (
                    <span
                      className="ps-6.5 text-xs text-amber-700 dark:text-amber-400"
                      data-testid="mcp-consent-path-warning"
                    >
                      {ptyAvailable ? (
                        <Trans comment="Warning shown when the user unchecks the PATH toggle on a desktop build with the built-in terminal">
                          <code className="inline-code">ok</code> won't run in external terminals
                          until you add it later from the File menu. OpenKnowledge's built-in
                          terminal and AI tools keep working.
                        </Trans>
                      ) : (
                        <Trans comment="Warning shown when the user unchecks the PATH toggle on a desktop build without the built-in terminal">
                          <code className="inline-code">ok</code> won't run in external terminals
                          until you add it later from the File menu. Your AI tools keep working.
                        </Trans>
                      )}
                    </span>
                  )}
                </Label>
              </div>
            </div>
          )}

          {/*
           * The AI-tools decision. One checkbox for every detected tool plus the
           * offered skill bundles; the label names the tools so the collapsed
           * state still discloses the write set.
           */}
          <div className="flex flex-col gap-1.5">
            {pathInstall.shellDetected && (
              <div className="text-xs font-medium text-muted-foreground">
                <Trans comment="Section label above the AI-tools checkbox in the first-launch dialog">
                  AI tools
                </Trans>
              </div>
            )}
            {hasEditors ? (
              <div className="overflow-hidden rounded-md border border-border bg-card/50">
                <Label
                  htmlFor={`${idPrefix}-connect`}
                  className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 font-normal hover:bg-accent"
                >
                  <Checkbox
                    id={`${idPrefix}-connect`}
                    checked={connectChecked}
                    disabled={busy}
                    onCheckedChange={() => setConnectChecked((prev) => !prev)}
                    className="mt-0.5"
                    data-testid="mcp-consent-connect-checkbox"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className="text-sm font-medium text-foreground"
                      data-testid="mcp-consent-connect-summary"
                    >
                      {t`Set up ${formatToolList(
                        editors.map((e) => e.label),
                        i18n.locale,
                      )}`}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {skillsOffered ? (
                        <Trans comment="Subtext under the single AI-tools checkbox when a skill is also installed">
                          Adds OpenKnowledge's MCP connection to each, plus the
                          open-knowledge-discovery skill so your agents recognize OpenKnowledge
                          projects.
                        </Trans>
                      ) : (
                        <Trans comment="Subtext under the single AI-tools checkbox when only MCP is wired">
                          Adds OpenKnowledge's MCP connection to each.
                        </Trans>
                      )}
                    </span>
                    {/* Overwrite disclosure lives beside the checkbox, never behind
                      the expander — replacing a config the user never saw named is
                      the one outcome a collapsed summary must not hide. Gated on
                      the checkbox too: "Replaces …" is present tense, so leaving it
                      up after an uncheck states a consequence that will not happen,
                      and reads to a consent-conscious user as the uncheck not
                      having taken. The expander stays ungated — it describes what
                      the setup writes, which is the thing being decided about. */}
                    {connectChecked && replacing.length > 0 && (
                      <span
                        className="text-xs text-amber-700 dark:text-amber-400"
                        data-testid="mcp-consent-connect-replace-warning"
                      >
                        {t`Replaces the existing OpenKnowledge entry in ${formatToolList(
                          replacing.map((e) => e.label),
                          i18n.locale,
                        )}`}
                      </span>
                    )}
                  </span>
                </Label>
                <div className="border-t border-border">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start gap-1 rounded-none px-3 py-2 text-xs font-normal text-muted-foreground hover:text-foreground"
                    onClick={() => setShowDetails((v) => !v)}
                    data-testid="mcp-consent-details-toggle"
                    aria-expanded={showDetails}
                    aria-controls={`${idPrefix}-details`}
                  >
                    {showDetails ? (
                      <>
                        <ChevronUp className="size-3.5" aria-hidden />
                        <Trans comment="Collapses the list of files the setup writes to">
                          Hide details
                        </Trans>
                      </>
                    ) : (
                      <>
                        <ChevronDown className="size-3.5" aria-hidden />
                        <Trans comment="Expands the list of files the setup writes to">
                          What this changes
                        </Trans>
                      </>
                    )}
                  </Button>
                  {/* The region element is always present so the toggle's
                    `aria-controls` never dangles — axe flags a reference to an
                    id that isn't in the DOM, which is exactly what a
                    conditionally-mounted target produces. */}
                  <div id={`${idPrefix}-details`}>
                    {showDetails && (
                      <div
                        className="flex flex-col gap-3 border-t border-border px-3 py-2.5"
                        data-testid="mcp-consent-details"
                      >
                        <div className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            <Trans comment="Heading above the per-tool MCP config paths in the disclosure">
                              MCP connections
                            </Trans>
                          </span>
                          <ul className="flex flex-col gap-1.5">
                            {editors.map((editor) => (
                              <li
                                key={editor.id}
                                className="flex min-w-0 flex-col"
                                data-testid={`mcp-consent-detail-${editor.id}`}
                              >
                                <span className="text-1sm text-foreground">{editor.label}</span>
                                <span className="text-xs text-muted-foreground wrap-break-word">
                                  <code className="break-all">
                                    {editor.configPath ?? t`unavailable on this platform`}
                                  </code>{' '}
                                  · <code className="break-all">{editor.entryLocator}</code>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                        {globalSkills.map((skill) => (
                          <div
                            key={skill.id}
                            className="flex flex-col gap-1"
                            data-testid={`mcp-consent-detail-skill-${skill.id}`}
                          >
                            <span className="text-xs font-medium text-muted-foreground">
                              <Trans comment="Heading above the skill install destinations in the disclosure">
                                Agent Skill
                              </Trans>
                            </span>
                            <span className="text-1sm text-foreground">
                              <code>{skill.name}</code>
                            </span>
                            <ul className="flex flex-col">
                              {skill.paths.map((path) => (
                                <li
                                  key={path}
                                  className="text-xs text-muted-foreground wrap-break-word"
                                >
                                  <code className="break-all">{path}</code>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              /* Nothing detected: no checkbox, because there is nothing to write.
                 The Terminal row above may still be actionable, so the dialog
                 itself stays. */
              <p
                className="rounded-md border border-border bg-card/50 px-3 py-2.5 text-1sm text-muted-foreground"
                data-testid="mcp-consent-no-tools"
              >
                <Trans comment="Shown in place of the AI-tools checkbox when no AI tool was detected">
                  No AI tools detected yet. Once you install one, connect it from Settings &gt; AI
                  tools & CLI.
                </Trans>
              </p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          {/* One button: with a single checkbox, a separate "Skip" would be a
            second way to say what unchecking already says. ESC / outside-click
            still route to skip() — that path made no decision at all. */}
          <Button onClick={() => void onContinue()} disabled={busy} data-testid="mcp-consent-add">
            {busy ? (
              <Trans>Working</Trans>
            ) : (
              <Trans comment="Primary button that applies the first-launch setup choices">
                Continue
              </Trans>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Default export so `React.lazy()` can consume this module directly without
// an intermediate `.then(m => ({ default: m.McpConsentDialogBody }))` trampoline.
export default McpConsentDialogBody;

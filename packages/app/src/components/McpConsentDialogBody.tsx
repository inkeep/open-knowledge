/**
 * Consent dialog implementation — split out from `McpConsentDialog.tsx`
 * so that file can lazy-load this module via `React.lazy()`. See that file's
 * header for the why.
 *
 * Minimum-viable UI: title, scrollable checkbox list of detected
 * editors (preselected — true if detection.detected), Add primary +
 * Skip secondary. ESC / outside-click = skip via shadcn Dialog's built-in
 * behavior (routed through `onOpenChange(false)` → skip()).
 *
 * The dialog also gates the shell-PATH install: a distinct pre-checked
 * toggle in its own "Terminal" section pinned above the scrollable editor
 * list, driven by `payload.pathInstall`. Hidden when no rc file is
 * touchable; informational when the managed block is already on disk /
 * consent already granted. Unchecking degrades only `ok` in EXTERNAL
 * terminals — OpenKnowledge's built-in terminal injects `~/.ok/bin` itself
 * and MCP wiring runs over npx, so the warning copy is scoped to exactly
 * that.
 */

import { Trans, useLingui } from '@lingui/react/macro';
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
import type { OkMcpWiringEditorId, OkMcpWiringShowPayload } from '@/lib/desktop-bridge-types';
import { type McpConsentStore, mcpConsentStore } from '@/lib/mcp-consent-store';

type EditorDetection = OkMcpWiringShowPayload['detectedEditors'][number];
type PathInstallDescriptor = OkMcpWiringShowPayload['pathInstall'];
type GlobalSkillDescriptor = OkMcpWiringShowPayload['globalSkills'][number];

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
 * Pure helper: from the detection payload, compute the initial checkbox
 * state — each detected editor starts checked, undetected
 * editors start unchecked but still appear in the list.
 */
export function computeInitialSelection(
  detectedEditors: readonly EditorDetection[],
): ReadonlySet<OkMcpWiringEditorId> {
  const out = new Set<OkMcpWiringEditorId>();
  for (const d of detectedEditors) if (d.detected) out.add(d.id);
  return out;
}

/** Pure helper: toggle a checkbox; returns a new Set (immutable-style). */
export function toggleSelectedId(
  prev: ReadonlySet<OkMcpWiringEditorId>,
  id: OkMcpWiringEditorId,
): ReadonlySet<OkMcpWiringEditorId> {
  const next = new Set(prev);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

/**
 * Pure helper: project the selected Set back into an array preserving the
 * detection payload's order. Used at confirm time so downstream writes iterate
 * editors in the same order the user saw them.
 */
export function selectedIdsOrdered(
  selection: ReadonlySet<OkMcpWiringEditorId>,
  detectedEditors: readonly EditorDetection[],
): OkMcpWiringEditorId[] {
  const out: OkMcpWiringEditorId[] = [];
  for (const d of detectedEditors) if (selection.has(d.id)) out.push(d.id);
  return out;
}

/**
 * Pure helper: initial skill checkbox state — every offered bundle starts
 * checked (opt-out default: preserves today's install-everywhere behavior
 * while making it one-click-off).
 */
export function computeInitialSkillSelection(
  globalSkills: readonly GlobalSkillDescriptor[],
): ReadonlySet<string> {
  return new Set(globalSkills.map((s) => s.id));
}

/** Pure helper: toggle a skill checkbox; returns a new Set. */
export function toggleSkillId(prev: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Pure helper: project the checked skills back into payload order. */
export function skillIdsOrdered(
  selection: ReadonlySet<string>,
  globalSkills: readonly GlobalSkillDescriptor[],
): string[] {
  return globalSkills.filter((s) => selection.has(s.id)).map((s) => s.id);
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

/** Minimal `sonner` surface the dialog uses — only `error`. */
export interface ToastImpl {
  error(message: string): void;
}

const defaultToast: ToastImpl = {
  error: (message) => sonnerToast.error(message),
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
  const detectedEditors = payload.detectedEditors;
  const pathInstall = payload.pathInstall;
  const globalSkills = payload.globalSkills;
  const skillsOffered = globalSkills.length > 0;
  const pathActionable = isPathRowActionable(pathInstall);
  const [selection, setSelection] = useState<ReadonlySet<OkMcpWiringEditorId>>(() =>
    computeInitialSelection(detectedEditors),
  );
  // Pre-checked (opt-out) when the row solicits a decision; informational
  // rows render force-checked + disabled below and never read this state.
  const [pathChecked, setPathChecked] = useState(true);
  // Pre-checked (opt-out) — every offered bundle starts on.
  const [skillSelection, setSkillSelection] = useState<ReadonlySet<string>>(() =>
    computeInitialSkillSelection(globalSkills),
  );
  const [busy, setBusy] = useState(false);
  const idPrefix = useId();

  function onToggle(id: OkMcpWiringEditorId) {
    setSelection((prev) => toggleSelectedId(prev, id));
  }

  async function onAdd() {
    setBusy(true);
    const result = await store.confirm({
      editorIds: selectedIdsOrdered(selection, detectedEditors),
      pathInstall: pathActionable ? pathChecked : undefined,
      // When skills are offered, always send the (possibly empty) selection so
      // main records a decision for every bundle — an empty list declines both.
      skills: skillsOffered ? skillIdsOrdered(skillSelection, globalSkills) : undefined,
    });
    // Success: the store clears `currentRequest` → useSyncExternalStore
    // unmounts this subtree, so there's nothing to reset. Failure
    // (ok:false / thrown rejection): the store KEEPS the snapshot
    // populated, so we must reset
    // `busy` here or the Add button stays disabled forever and same-boot
    // retry is impossible. Sonner is mounted globally in main.tsx; the
    // toast surfaces even if the dialog were to unmount.
    if (!result.ok) {
      toast.error(result.error);
      setBusy(false);
    }
  }

  async function onSkip() {
    setBusy(true);
    const result = await store.skip();
    if (!result.ok) {
      toast.error(result.error);
      // Matching rationale to onAdd — reset `busy` so Skip stays
      // clickable after a transient marker-write failure.
      setBusy(false);
    }
  }

  function onOpenChange(open: boolean) {
    // ESC, outside-click, X button — treat as skip.
    if (!open && !busy) void onSkip();
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      {/*
       * Radix Dialog auto-wires `aria-labelledby` / `aria-describedby` on
       * `DialogContent` from `DialogTitle` / `DialogDescription` via context
       * — no manual `useId` plumbing needed. Each row's `<Label>` is
       * associated to its `<Checkbox>` by
       * `htmlFor` + matching `id`, providing the accessible name; no
       * `aria-describedby` on the checkbox itself, since duplicating the
       * label content via that attr causes screen readers to either
       * announce the label twice or drop the association.
       */}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add OpenKnowledge to your AI tools</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              OpenKnowledge manages the <code>open-knowledge</code> MCP server name, the{' '}
              <code>open-knowledge-ui</code> launch config, and <code>ok</code> /{' '}
              <code>open-knowledge</code> on PATH (including OK-owned symlinks). Using a custom
              wrapper? Register it under a different name.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        {/*
         * Shell-PATH consent section — its own pinned block ABOVE the
         * scrollable editor list (DialogBody is the overflow container; a
         * row inside it sits below the fold on machines with many editors).
         * Distinct from the per-editor MCP checkboxes because the two
         * decisions are independent (MCP runs over npx / the bundle
         * wrapper, never bare `ok`). Hidden when no rc file is touchable;
         * informational when a managed block is already on disk or consent
         * was already granted.
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
                className={
                  pathActionable
                    ? 'flex cursor-pointer items-start gap-2.5 px-3 py-2.5 font-normal hover:bg-accent'
                    : 'flex items-start gap-2.5 px-3 py-2.5 font-normal'
                }
              >
                <Checkbox
                  id={`${idPrefix}-path`}
                  checked={pathActionable ? pathChecked : true}
                  disabled={busy || !pathActionable}
                  onCheckedChange={() => setPathChecked((prev) => !prev)}
                  className="mt-0.5"
                  data-testid="mcp-consent-path-checkbox"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">
                    <Trans comment="Toggle in the first-launch dialog that adds the ok CLI to the user's shell PATH">
                      Add the <code>ok</code> command to your terminal
                    </Trans>
                  </span>
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid="mcp-consent-path-status"
                  >
                    {pathActionable
                      ? t`Adds a managed block to ${pathInstall.rcFilesToTouch.join(', ')}`
                      : t`Already set up — ok is available in your terminal`}
                  </span>
                  {pathActionable && !pathChecked && (
                    <span
                      className="text-xs text-amber-600 dark:text-amber-400"
                      data-testid="mcp-consent-path-warning"
                    >
                      <Trans comment="Warning shown when the user unchecks the PATH toggle — only external terminals degrade">
                        <code>ok</code> won't run in external terminals until you add it later from
                        the File menu. OpenKnowledge's built-in terminal and AI tools keep working.
                      </Trans>
                    </span>
                  )}
                </span>
              </Label>
            </div>
          </div>
        )}

        <DialogBody>
          {/* Group label only when the Terminal section renders above —
              with a single group there is nothing to distinguish. */}
          {pathInstall.shellDetected && (
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">
              <Trans comment="Section label above the editor checkbox list in the first-launch dialog">
                AI tools
              </Trans>
            </div>
          )}
          <ul className="rounded-md border border-border bg-card/50 divide-y divide-border overflow-hidden">
            {detectedEditors.map((editor) => {
              const checked = selection.has(editor.id);
              const checkboxId = `${idPrefix}-${editor.id}`;
              // Per-editor disclosure when Add will overwrite the desktop-owned
              // open-knowledge namespace. Any existing entry under that name is
              // reclaimed; custom wrappers should use a different MCP server name.
              const statusLabel = editor.willReplace
                ? t`Will replace existing OpenKnowledge entry`
                : editor.detected
                  ? t`Detected on this machine`
                  : t`Not detected`;
              const statusClass = editor.willReplace
                ? 'text-xs text-amber-600 dark:text-amber-400'
                : 'text-xs text-muted-foreground';
              return (
                <li key={editor.id}>
                  <Label
                    htmlFor={checkboxId}
                    className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 font-normal hover:bg-accent"
                  >
                    <Checkbox
                      id={checkboxId}
                      checked={checked}
                      disabled={busy}
                      onCheckedChange={() => onToggle(editor.id)}
                      className="mt-0.5"
                      data-testid={`mcp-consent-checkbox-${editor.id}`}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">{editor.label}</span>
                      <span className={statusClass} data-testid={`mcp-consent-status-${editor.id}`}>
                        {statusLabel}
                      </span>
                    </span>
                  </Label>
                </li>
              );
            })}
          </ul>
        </DialogBody>

        {/*
         * User-global Agent Skills consent section — one pre-checked row per
         * bundle. Distinct from the editor list because skills install to every
         * detected host by design (not per-editor). Unchecking an already-
         * installed bundle removes it; the decision is honored by every install
         * actor (desktop reclaim, ok init, ok start).
         */}
        {skillsOffered && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              <Trans comment="Section label above the skill checkboxes in the first-launch dialog">
                Agent Skills
              </Trans>
            </span>
            <ul className="rounded-md border border-border bg-card/50 divide-y divide-border overflow-hidden">
              {globalSkills.map((skill) => {
                const checked = skillSelection.has(skill.id);
                const checkboxId = `${idPrefix}-skill-${skill.id}`;
                return (
                  <li key={skill.id}>
                    <Label
                      htmlFor={checkboxId}
                      className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 font-normal hover:bg-accent"
                    >
                      <Checkbox
                        id={checkboxId}
                        checked={checked}
                        disabled={busy}
                        onCheckedChange={() =>
                          setSkillSelection((prev) => toggleSkillId(prev, skill.id))
                        }
                        className="mt-0.5"
                        data-testid={`mcp-consent-skill-checkbox-${skill.id}`}
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-sm font-medium text-foreground">
                          <code>{skill.name}</code>
                        </span>
                        <span
                          className="text-xs text-muted-foreground"
                          data-testid={`mcp-consent-skill-status-${skill.id}`}
                        >
                          {skill.id === 'discovery' ? (
                            <Trans comment="Subtext for the open-knowledge-discovery skill row">
                              Helps your coding agent recognize OpenKnowledge projects and route
                              reads and writes through it.
                            </Trans>
                          ) : (
                            <Trans comment="Subtext for the open-knowledge-write-skill skill row">
                              Adds a guided workflow for authoring new Agent Skills.
                            </Trans>
                          )}
                        </span>
                        {skill.alreadyInstalled && !checked && (
                          <span
                            className="text-xs text-amber-600 dark:text-amber-400"
                            data-testid={`mcp-consent-skill-warning-${skill.id}`}
                          >
                            <Trans comment="Warning shown when the user unchecks an already-installed skill">
                              Removes this skill from your editors.
                            </Trans>
                          </span>
                        )}
                      </span>
                    </Label>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            className="font-mono uppercase"
            onClick={() => void onSkip()}
            disabled={busy}
            data-testid="mcp-consent-skip"
          >
            <Trans comment="Secondary button — dismisses the dialog without wiring any tools">
              Skip
            </Trans>
          </Button>
          <Button
            onClick={() => void onAdd()}
            disabled={
              busy || (selection.size === 0 && !(pathActionable && pathChecked) && !skillsOffered)
            }
            data-testid="mcp-consent-add"
          >
            {busy ? (
              <Trans>Working</Trans>
            ) : (
              <Trans comment="Primary button that writes MCP config for the selected AI tools">
                Add
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

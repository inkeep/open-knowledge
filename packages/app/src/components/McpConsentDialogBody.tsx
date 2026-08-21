/**
 * Consent dialog implementation — split out from `McpConsentDialog.tsx`
 * so that file can lazy-load this module via `React.lazy()`. See that file's
 * header for the why.
 *
 * One decision per independent consequence, and no more. Three rows, because
 * three things can be wanted separately: the shell-PATH install (MCP runs over
 * npx / the bundle wrapper and never over bare `ok`), the MCP wiring into every
 * detected tool, and the skill bundle, which lands in each agent host's own
 * skills root rather than in any tool's MCP config. The skill row is offered
 * only when the payload names at least one destination — those roots are
 * existsSync-gated in main and none are created, so a machine with no agent
 * tool has nowhere to put it.
 *
 * Per-TOOL granularity is still refused here — one checkbox covers every
 * detected tool, and picking among them lives in Settings → AI tools & CLI.
 * That is the split that made a first-run screen the user had to audit row by
 * row; separating consequences that land in different places is not.
 *
 * Consent integrity — this dialog fires once, so it must disclose exactly what
 * it will touch:
 *   - A replacement warning sits inline next to the checkbox, never behind an
 *     affordance, so an overwrite is never something the user had to go looking
 *     for.
 *   - The MCP row's subtext NAMES every tool in the write set, without opening
 *     anything. A tooltip is the disclosure a touch or trackpad user is least
 *     likely to reach, so which configs get written stays in the always-visible
 *     tier; only where exactly they live sits behind the info affordance.
 *   - Each row's info tooltip lists the exact files, entries and skill
 *     destinations that row writes. Every path comes from main's descriptors,
 *     which are computed from the installer's own iteration set and gates —
 *     never re-derived here.
 *
 * Undetected tools are absent entirely: a row that writes nothing is noise on a
 * first-run screen, and Settings lists them all.
 *
 * The screen only ever ADDS. Leaving the skill box unchecked records no skill
 * decision (`skills: undefined`, which main reads as "no decision" rather than
 * "decline all"), so declining here can never tear down a bundle already on
 * disk.
 * Removal is Settings' job, where the row states what it removes.
 */

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

/**
 * Every secondary line in this dialog shares one size and leading, so the
 * Terminal, AI-tools, and skill rows read as one column of text rather than
 * three slightly different ones. Indent is per-context — a row's subtext aligns
 * under its checkbox label, a section's does not — and color carries the role.
 */
const SUBTEXT = 'text-1sm leading-normal';
const ROW_SUBTEXT = `${SUBTEXT} ps-6.5 text-muted-foreground`;
const ROW_WARNING = `${SUBTEXT} ps-6.5 text-amber-700 dark:text-amber-400`;
const SECTION_SUBTEXT = `${SUBTEXT} text-muted-foreground`;

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
 * The two shells this screen renders in. ONLY the shell differs — the heading,
 * every row of the form, and the primary action are authored once below and
 * mount into whichever is selected, so the two entry points cannot drift apart.
 *
 * first-run is the unsolicited showing, and the only one that earns a surface
 * the user cannot wave away: Radix preventDefaults outside-pointer dismissal on
 * an alert dialog and moves initial focus onto its cancel element, which is why
 * the footer keeps an `AlertDialogCancel` in that mode specifically.
 *
 * Every other entry point is the user asking for this screen, and gets the
 * ordinary dialog treatment — close X, click-outside, Escape — because a screen
 * you deliberately opened should close the way every other one does. That shell
 * is stock `Dialog`, with no per-call-site deviation: the whole point is that it
 * behaves like every other dialog in the app.
 */
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

/**
 * Test-injectable store + toast — production consumers use the default
 * exports. Exposed as props so the tests don't need to reset module
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
  // Subscribed, not a bare read. The lazy wrapper above subscribes with a
  // derived boolean (`getSnapshot() !== null`), so a payload REPLACEMENT —
  // non-null to non-null — bails out of its `Object.is` check and never
  // re-renders. That was harmless while both payloads rendered the same shell;
  // now that `origin` picks the shell, a 'reconfigure' arriving over an open
  // first-run dialog would leave the locked one on screen. Reachable on macOS:
  // the native File menu is OS-level and stays clickable behind a web modal.
  // The `payload` prop override is test-only and skips the subscription.
  const subscribed = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
  const snapshot = payload ?? subscribed;

  /**
   * A replacement must REMOUNT the form, not reconcile it.
   *
   * Every piece of the form's answer lives in `useState` — `busy`, and the three
   * checkboxes. Without a changing key React keeps all of it across a swap, so
   * the incoming request inherits the outgoing one's state. The acute case is
   * `busy`: a confirm in flight when a reconfigure arrives hands the user a
   * freshly-opened dialog that is entirely disabled with no exit, and then
   * unmounts it under them when the original confirm resolves and clears the
   * store. Carrying checkbox answers across two different requests is wrong on
   * its own — a new showing asks the question again.
   *
   * Counted rather than keyed off payload contents: two successive reconfigures
   * can be structurally identical, and a content-derived key would collide on
   * exactly the repeat case. This is React's documented "adjust state when a
   * prop changes" shape — the extra render happens before children commit, so
   * the stale form never paints.
   */
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
  // A bundle with no destinations installs nowhere: main computes `paths` by
  // existsSync-filtering the agent host dirs (`~/.claude/skills`, `~/.cursor/
  // skills`, …) plus the `~/.agents` hub, and it creates none of them. With no
  // agent tool on the machine that list is empty, so offering the row would be
  // a pre-checked box that writes nothing.
  const skillsOffered = globalSkills.some((skill) => skill.paths.length > 0);
  const pathActionable = isPathRowActionable(pathInstall);
  const ptyAvailable = window.okDesktop?.config.ptyAvailable === true;
  const editors = connectableEditors(payload.detectedEditors);
  const hasEditors = editors.length > 0;
  const replacing = editors.filter((e) => e.willReplace);
  // Every tool being written is also being overwritten — the neutral subtext and
  // the warning would name an identical list.
  const replacingAll = replacing.length > 0 && replacing.length === editors.length;
  // Named local so the `<Trans>` placeholder extracts as `{connectToolList}`
  // rather than a positional index for the inline call expression.
  const connectToolList = formatToolList(
    editors.map((e) => e.label),
    i18n.locale,
  );
  // Pre-checked (opt-out): the common answer is yes, and the label names
  // everything it covers so agreeing isn't agreeing blind.
  const [connectChecked, setConnectChecked] = useState(true);
  // Its own decision, not a rider on the MCP row: the bundle installs into
  // user-global agent directories rather than any detected tool's config.
  const [skillsChecked, setSkillsChecked] = useState(true);
  // Pre-checked (opt-out) when the row solicits a decision; informational
  // rows render force-checked + disabled below and never read this state.
  const [pathChecked, setPathChecked] = useState(true);
  // next-themes owns both the applied class and the localStorage cache the
  // pre-paint FOUC script reads, so setting it here is the whole commit.
  // `theme` is the stored PREFERENCE ('system' included), not the resolved
  // mode — resolvedTheme would show 'dark' for a system pick and check the
  // wrong card.
  const { theme, setTheme } = useTheme();
  const themePreference = narrowThemePreference(theme);
  // Optional because this dialog also renders in the Navigator window, which has
  // no server and therefore no ConfigProvider.
  const configContext = useConfigContextOptional();

  /**
   * next-themes alone is not the whole commit. It flips the class and writes the
   * `ok-theme-v1` FOUC cache, but two surfaces read `appearance.theme` from
   * config instead: `useThemeBridge` (Electron's native window chrome) and the
   * Settings appearance toggle. Writing only next-themes leaves a Dark pick with
   * light native chrome and a Settings toggle still reading System.
   *
   * So: next-themes first, for the instant flip and the cache, then canonicalize
   * into `config.yml` through the same `userBinding.patch()` the Settings pane
   * uses. `appearance.theme` is user-scope by schema. In the Navigator there is
   * no binding and the localStorage cache carries the pick into the first editor
   * window, which is the pre-existing dual-track behavior.
   */
  function commitTheme(next: ThemePreference): void {
    setTheme(next);
    const binding = configContext?.userBinding;
    if (!binding) return;
    const result = binding.patch({ appearance: { theme: next } });
    if (!result.ok) {
      // The visual flip already happened and survives via localStorage, so this
      // is a persistence miss rather than a failed interaction — surface it
      // without taking the dialog down.
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
      // An array records a decision for every offered bundle; `undefined` records
      // none. Declining setup must leave an existing install alone, so the
      // decline path sends `undefined`, never `[]`.
      skills: skillsChecked && skillsOffered ? globalSkills.map((s) => s.id) : undefined,
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

  // first-run is the only unsolicited showing; everything else is the user
  // asking for this screen. See FIRST_RUN_SURFACE.
  const firstRun = payload.origin === 'first-run';
  const Surface = firstRun ? FIRST_RUN_SURFACE : DISMISSIBLE_SURFACE;

  /**
   * Leaving a screen you opened yourself must not rewrite what you already
   * decided. `skip()` writes `{ configured: false, skippedAt }` unconditionally,
   * so routing a reopen's exits there would downgrade a finished setup's
   * `{ configured: true, configuredAt, editors }` marker to a skip and lose the
   * real `configuredAt` — a control labelled Cancel writing state is the
   * opposite of what the label promises. `dismiss()` closes the dialog and
   * touches nothing, which is the whole meaning of cancelling here: the marker's
   * only job is the first-launch gate, and a reopen cannot change that answer.
   *
   * No toast either. Skip's "configure this in Settings" pointer exists because
   * a first-run user may never find the surface again; someone who just opened
   * it from the palette or the menu bar knows exactly where it lives, and a
   * toast after Cancel would imply something was recorded.
   */
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
      // Matching rationale to onContinue — reset `busy` so the dialog stays
      // usable after a transient marker-write failure.
      setBusy(false);
    }
  }

  function onOpenChange(open: boolean) {
    // Every close route lands here, and none of them made a decision — but the
    // two shells record that differently. First run (ESC, the footer's cancel
    // element) writes the skip marker, which is what stops the dialog firing
    // again next launch. A reopen (close X, outside-click, ESC) records nothing
    // at all; see onDismiss. The dismissible footer's Cancel calls `onDismiss`
    // directly instead — it is a plain Button, so nothing closes the dialog out
    // from under it and this handler never sees that click.
    if (open || busy) return;
    if (firstRun) void onSkip();
    else onDismiss();
  }

  return (
    <Surface.Root open onOpenChange={onOpenChange}>
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
      <Surface.Content
        className={cn(
          'sm:max-w-2xl md:max-w-3xl',
          // Every control in the form carries `disabled={busy}`; the close X
          // belongs to DialogContent and cannot, so it would sit fully lit while
          // `onOpenChange` silently no-ops on it. Match the others rather than
          // leave the one control that lies about its state.
          busy &&
            '[&_[data-slot=dialog-close]]:pointer-events-none [&_[data-slot=dialog-close]]:opacity-50',
        )}
        aria-busy={busy}
      >
        <Surface.Header>
          <Surface.Title className="flex flex-col gap-8 text-2xl tracking-tighter">
            {/* Brand mark, not an information-bearing image — the heading
                below already names OpenKnowledge, so announcing the logo too
                would just repeat it. `aria-hidden` overrides the icon's own
                role="img" + label. */}
            <OkIcon className="size-10 shrink-0" aria-hidden />
            {/* A span, not a div: this is inside AlertDialogTitle's <h2>, which
                takes phrasing content. `flex` makes it lay out identically. */}
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
              <h3 className="text-sm font-medium text-foreground">
                <Trans comment="Section label above the shell-PATH toggle in the first-launch dialog">
                  Terminal
                </Trans>
              </h3>
              {/* The disclosure button is a SIBLING of the label, not a child:
                nested inside, every click on it had to be intercepted to stop it
                toggling the checkbox, and a text-sized target makes that much
                more label area that mysteriously does nothing. */}
              <div
                className={cn(
                  'relative overflow-hidden rounded-lg border border-border bg-card/50 px-4 py-3',
                  pathActionable && 'hover:bg-accent',
                )}
              >
                <Label
                  htmlFor={`${idPrefix}-path`}
                  // items-start overrides the shadcn Label base `items-center`,
                  // which on a flex column would center every child horizontally.
                  className={
                    pathActionable
                      ? 'flex min-w-0 cursor-pointer flex-col items-start gap-1 font-normal'
                      : 'flex min-w-0 flex-col items-start gap-1 font-normal'
                  }
                >
                  {/* Checkbox centered against the title line only (not the whole
                    column) so the `ok` code chip — taller than plain text — can't
                    push it out of alignment. Subtexts sit below, indented to align
                    under the title (checkbox size-4 = 1rem + gap-2.5 = 0.625rem).
                    */}
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

          {/* Nothing to offer, nothing to show: with no detected tool AND no
            skill destination, every control in this section would be absent, and
            a lone heading over an explanatory line is a section that exists only
            to say it is empty. Note this drops the pointer to Settings > AI tools
            & CLI in that state — the dialog is one-shot, so a user who installs a
            tool later has to find that pane on their own. */}
          {(hasEditors || skillsOffered) && (
            <>
              {/*
               * The AI-tools decision, split in two because the consequences are
               * independent: MCP wiring edits each detected tool's own config, while
               * the skill bundle installs into user-global agent directories. A user
               * can reasonably want either without the other, and the confirm payload
               * has always carried them as separate fields.
               *
               * Exact write destinations live in each row's info tooltip rather than a
               * shared expander, so the disclosure sits with the decision it belongs
               * to. The overwrite warning stays inline — replacing a config the user
               * never saw named is the one outcome that must not be behind an
               * affordance they have to discover.
               */}
              <div className="flex flex-col gap-1.5">
                <h3 className="text-sm font-medium text-foreground">
                  <Trans comment="Section label above the AI-tools checkboxes in the first-launch dialog">
                    Connect your AI tools
                  </Trans>
                </h3>
                {/* The description names only what is actually on offer below it.
                With no tool detected there is no MCP wiring to do, so promising it
                would describe a row that isn't there. */}
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
                        {/* Always present, and worded the same in both states: this
                        describes what the option does, so it has to stay put when
                        the box is toggled rather than swapping for another
                        sentence. */}
                        <span className={ROW_SUBTEXT}>
                          {/* Tool names carry the emphasis: they are the part of
                            this sentence that differs per machine. Wording
                            tracks the create-project dialog's AI-tools row,
                            minus the project skill: that row writes one and
                            this screen, which sets up no project, does not. */}
                          <Trans comment="Subtext under the AI-tools MCP checkbox">
                            Adds an OpenKnowledge MCP entry to{' '}
                            <span className="font-medium text-foreground">{connectToolList}</span>,
                            so your agents can read and edit your files.
                          </Trans>
                        </span>
                        {/* Gated on the checkbox: "Replaces …" is present tense, so
                        leaving it up after an uncheck states a consequence that will
                        not happen, and reads to a consent-conscious user as the
                        uncheck not having taken. */}
                        {showReplaceWarning && (
                          <span
                            className={ROW_WARNING}
                            data-testid="mcp-consent-connect-replace-warning"
                          >
                            {/* When the replacement set is the whole write set the
                            line above just named it, so repeating it here would
                            print the same eight tools twice. A subset still has to
                            be named — it is not derivable from the line above. */}
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

                  {/* Offered whether or not a tool was detected: the bundle installs
                  into user-global agent directories, so it is useful ahead of the
                  first tool rather than only alongside one. */}
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

                  {/* Nothing detected: a note, not a card. There is no decision to
                  make here, and a bordered empty row reads as a control the user
                  is failing to use. It carries the only pointer to the recovery
                  path — this dialog fires once per user, so someone who installs
                  a tool next week never sees it again. */}
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
          {/* Appearance. Unlike the rows above this writes nothing on confirm —
            `next-themes` applies and persists the pick the moment it's made, so
            Skip keeps it too. That's deliberate: a theme is reversible and
            immediately visible, so asking the user to also press Finish to keep
            what they can already see would be a confirmation for its own sake. */}
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
          {/* Skip and an all-unchecked Finish are NOT the same outcome, so both
            are offered: skip writes the marker and nothing else, while Finish
            records an explicit decline for every offered target. Skip stays
            visually quiet so it reads as "not now" rather than "no". ESC routes
            here too. */}
          {/* The one element that genuinely differs per shell, for two reasons.
            Semantics: on first run this IS the cancel action, and Radix moves
            initial focus onto `AlertDialogCancel` — with no such element in the
            tree it suppresses its own auto-focus and strands focus on <body>
            with the trap inert (see the header of `alert-dialog.tsx`). Wording:
            "Skip for now" answers a question the user did not ask for, while a
            screen they deliberately opened is one they cancel out of.

            `variant` goes on `AlertDialogCancel` rather than an inner `<Button
            asChild>`: it already renders a Button (defaulting to `outline`)
            around the Radix Cancel, so wrapping one adds a third Slot and merges
            the outline classes onto the final element. It also applies
            `font-mono uppercase` itself, which the plain Button has to restate.
            `-ms-2.5` offsets the size default's `px-2.5` so the focus ring keeps
            even padding while the label stays on the content edge.

            No `onClick` on the Cancel on purpose: it closes the dialog, which
            fires `onOpenChange(false)`, which is already the skip path — calling
            `onSkip` from both ran it twice per click. The plain Button is the
            mirror image: nothing closes the dialog for it, so it must call
            `onDismiss` itself. */}
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
              className="-ms-2.5 tracking-wide font-mono uppercase"
              data-testid="mcp-consent-skip"
              onClick={onDismiss}
            >
              {/* No `comment` here: this msgid is the shared "Cancel" that ~20
                  other components resolve to, and an extracted note would attach
                  setup-screen guidance to every one of their catalog entries.
                  The "Skip for now" comment above is safe — that msgid is unique
                  to this file. */}
              <Trans>Cancel</Trans>
            </Button>
          )}
          {/* The default variant already carries `font-mono uppercase`. */}
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

// Default export so `React.lazy()` can consume this module directly without
// an intermediate `.then(m => ({ default: m.McpConsentDialogBody }))` trampoline.
export default McpConsentDialogBody;

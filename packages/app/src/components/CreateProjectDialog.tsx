/**
 * Create-new-project dialog. Modal launched from the Navigator's "Create new
 * project" card; drives the user through a reactive cascade (enclosing-project
 * BLOCK → enclosing-git-repo CONFIRM → target-non-empty BLOCK → free) before
 * calling `bridge.project.createNew` to atomically mkdir + git-init +
 * content-init + write AI-editor integrations.
 *
 * Layout: shadcn Dialog. The form leads with a Project name <Input> (focused
 * on open) followed by a Location field (read-only display + Browse button
 * that picks the PARENT directory). A live "Will be created at: …" caption
 * shows the resolved target before submit. Below that sits the AI-tool
 * decision (`ProjectAiToolsField`) — one pre-checked checkbox whose subtext
 * names the detected tools, always visible, because whether the project is
 * reachable from the user's agents is not an advanced concern. The config-sharing
 * posture (side-by-side radio cards) sits at the top level too, matching the
 * open-folder consent dialog.
 * Cancel + Create footer. Create stays enabled with an empty name — a click then
 * surfaces an "Enter a project name" toast (see onSubmit) rather than sitting
 * disabled with no hint. The two fields (`location`, `name`) are the source of
 * truth; the submit IPC takes `{ parent: location, name, ... }` with no
 * signature change.
 *
 * Cascade state machine — pure function of (location, sanitizedName) and the
 * three bridge probe results. Probes are debounced ~180 ms after each
 * `location` or `name` change (or external nonce bump) so successive keystrokes
 * coalesce into a single round-trip; when a fresher probe supersedes an
 * in-flight one, the stale probe's settled results are discarded via an
 * `AbortController` signal check (the `bridge.fs.*` IPC calls themselves run
 * to completion — the signal is not threaded into them) so a fresher probe
 * always wins over a stale one.
 *
 * Re-probe triggers (beyond field changes):
 *   - Window `focus` event — catches "user switched to Finder, deleted the
 *     offending .git, came back" without requiring a form change.
 *   - 5 s polling timer, ONLY while cascade.kind === 'confirm-git' — once
 *     the user is staring at the .git-confirm banner, we re-probe every 5 s
 *     so an external `rm -rf .git` clears the banner without user input.
 *     Asymmetric on purpose: we don't poll to DISCOVER a newly-appearing
 *     .git, because the user only cares about confirming away an unwanted
 *     one.
 *   - Same-parent re-pick via Browse — `setLocation(location)` with an
 *     identical value bails out of React render scheduling, so onBrowse bumps
 *     the nonce too.
 *   All four triggers funnel through `probeNonce`, an integer that's a dep
 *   of the cascade-probe useEffect.
 *
 * Confirm-git banner action: a two-stage inline "Remove parent .git folder"
 * button surfaces in the banner. First click reveals the resolved path +
 * destructive-action warning; second click invokes
 * `bridge.fs.removeGitFolder(gitRoot)`. On success, a probeNonce bump
 * re-runs the probe — if a higher .git exists farther up the tree the
 * banner updates to point at it; if none does, the banner clears. Failure
 * surfaces inline so the user can retry or cancel.
 *
 * On submit:
 *   - happy path: `bridge.project.createNew` resolves; main opens the editor
 *     window; renderer closes the dialog. Renderer does NOT navigate.
 *   - failure: the IPC handler throws; reason is parsed from the thrown
 *     `Error.message` (Electron strips Error subclass identity over IPC),
 *     mapped to one of the documented variants, surfaced inline; dialog
 *     stays open so the user can retry.
 *
 * Telemetry: on first banner appearance per dialog open the renderer fires
 * `bridge.project.recordCreateNewBannerShown(banner)`. A nonce-driven
 * re-probe that returns the same cascade variant does NOT refire — dedupe
 * is per-dialog-open per banner.
 */

import {
  CREATE_NEW_PROJECT_FAILURE_REASONS,
  type CreateNewBannerKind,
  type CreateNewProjectFailureReason,
  EDITOR_LABELS,
  EDITOR_PROJECT_CONFIG_PATH,
  EDITOR_PROJECT_SKILL_ROOT,
  RESERVED_PROJECT_SKILL_NAME,
  receivesProjectIntegrationWrite,
  sanitizeFolderName,
} from '@inkeep/open-knowledge-core';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ArrowLeft } from 'lucide-react';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CreatedItemsList, CreatedItemsSkeleton } from '@/components/CreatedItemsList';
import { PackCardGrid } from '@/components/PackCardGrid';
import { RowDisclosure } from '@/components/RowDisclosure';
import { type SeedRootChoice, SeedRootPicker } from '@/components/SeedRootPicker';
import {
  DEFAULT_SHARING_MODE,
  type SharingMode,
  SharingModeField,
} from '@/components/SharingModeField';
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
import { formatToolList } from '@/lib/tool-list-format';
import { cn } from '@/lib/utils';

/**
 * Debounce window for the cascade probes. ~180 ms after a `name`/`location`
 * change or external nonce bump before fire — short enough to feel reactive,
 * long enough to coalesce rapid keystrokes or back-to-back window-focus +
 * remove-.git success into a single round-trip.
 */
const PROBE_DEBOUNCE_MS = 180;

/**
 * Poll interval for the confirm-git banner. Fires only while the user is
 * staring at the `.git`-confirm banner; each tick bumps `probeNonce` to
 * re-run the cascade probe so an external `rm -rf .git` clears the banner
 * within ~5 s of the on-disk delete. Asymmetric: we don't poll to discover
 * a newly-appearing `.git`, only to confirm one is gone.
 */
const GIT_BANNER_POLL_INTERVAL_MS = 5_000;

/**
 * Debounce for the starter-pack preview plan. Matches the in-project seed
 * dialog: the first plan of an open cycle fires immediately (the user just
 * picked a pack and expects to see it), later ones — driven by typing in the
 * subfolder field — wait this long so the list doesn't strobe per keystroke.
 */
const PACK_PREVIEW_DEBOUNCE_MS = 200;

// The settled verdict of the cascade probe. Drives banner mount: the render
// layer reads only this. A probe-in-flight discriminant is intentionally
// NOT a member here — see `ProbeLifecycle` below. Splitting the two
// orthogonally keeps `CascadeBanner` from keying its mount on a
// probe-lifecycle signal, which would unmount the banner DOM whenever the
// probe re-runs against an unchanged target.
type SettledCascade =
  | { kind: 'idle' }
  | { kind: 'block-nested'; rootPath: string }
  | { kind: 'confirm-git'; gitRoot: string }
  | { kind: 'block-nonempty' }
  | { kind: 'free' };

// Probe in-flight indicator. Lives parallel to `SettledCascade` so the
// banner's mount identity is decoupled from probe re-runs whose verdict is
// unchanged. Gates `canSubmit` (so the user can't submit a stale verdict
// mid-probe) but never reaches the render layer that mounts the banner.
type ProbeLifecycle = 'idle' | 'in-flight';

/**
 * Local state for the inline "Remove parent .git folder" action. Drives
 * the two-stage destructive-action UX on the confirm-git banner: idle →
 * confirming (path shown + destructive-action copy) → pending → idle (on
 * success — probeNonce bumps + the banner either disappears or repaints
 * with the next-higher .git) or error (inline retry).
 */
/**
 * Live preview of what the selected starter pack would scaffold into the
 * project about to be created. Planned against a throwaway directory main-side
 * (`preview` on the seed-plan channel) because this dialog runs on the
 * Navigator window, which has no project bound.
 */
type PackPreview =
  | { kind: 'loading' }
  | { kind: 'plan'; plan: OkScaffoldPlan }
  /**
   * `blocking` separates "you typed a root the planner rejects" from "the
   * preview could not be computed". Only the first withholds Create: the
   * second is not the user's fault and the pack is secondary to creating the
   * project, so a transport or internal failure must not strand someone with a
   * permanently disabled button.
   */
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

// Compile-time equality of two type arguments. Tuple-wrapped operands
// (`[A] extends [B]`) suppress the conditional-type distribution that would
// otherwise widen a one-directional mismatch to `boolean` — which a plain
// `const x: boolean = true` then accepts, letting drift pass silently.
type _Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// Bidirectional drift pin: if core's canonical `CreateNewProjectFailureReason`
// and the renderer's `CreateNewError` reasons (minus the renderer-only
// `'unknown'` IPC fallback) diverge in either direction, this resolves to
// `false` and the assignment fails to compile, flagging the missing literal.
const _CREATE_NEW_REASON_DRIFT_PIN: _Equals<
  CreateNewProjectFailureReason,
  Exclude<CreateNewError['reason'], 'unknown'>
> = true;
void _CREATE_NEW_REASON_DRIFT_PIN;

type CreateStep = 'pick' | 'review' | 'configure';

/**
 * The one place that knows where each screen puts focus.
 *
 * Every screen mounts a different body, so a target belonging to another screen
 * is null and `?.focus()` silently no-ops — dropping the user on whatever the
 * dialog primitive tabs to first, which on review is the control that discards
 * their pack. That has already cost one regression, so the mapping lives here
 * and nowhere else. Module scope rather than a closure so the on-open effect
 * can call it without taking it as a dependency.
 */
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
  /**
   * Starter pack pre-selected on the packs-forward first-run launcher. When
   * set (alongside a matching entry in `packs`), the dialog configures that
   * pack the same way the in-project seed dialog does — long-form blurb, root
   * chooser, live "What gets created" preview — and threads the choice into
   * `createNew` so the fresh project opens seeded. Unset → the blank-project
   * create flow (today's generic description, no pack UI).
   */
  initialPackId?: OkPackId;
  /**
   * The available starter packs. Supplies the selected pack's display metadata
   * and backs the in-dialog "Change pack" grid. Empty/omitted → the generic
   * blank-create description and no pack UI.
   */
  packs?: OkSeedPackInfo[];
}

/**
 * Join a parent and a basename with a forward-slash separator. The renderer
 * runs in a browser context; no `node:path` shim. Backslashes inside parent
 * are tolerated (e.g. Windows paths) — we don't normalize because the
 * server-side handler does the authoritative `path.resolve`. The caption is
 * a preview; what gets created is `resolve(parent, sanitized)` server-side.
 */
export function joinPathPreview(parent: string, basename: string): string {
  if (parent === '' || basename === '') return '';
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  const trimmed = parent.replace(/[/\\]+$/, '');
  return `${trimmed}${sep}${basename}`;
}

/**
 * Extract the trailing path component from a string that may use either
 * `/` or `\` as a separator. Browser-context (no `node:path`), so we
 * tolerate both — a future Windows port can deliver a backslash-shaped
 * `rootPath` over IPC without re-touching this surface. Returns the input
 * unchanged when no separator is found (e.g. a single-segment path).
 */
export function basenamePreview(path: string): string {
  if (path === '') return '';
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments.length > 0 ? (segments[segments.length - 1] ?? path) : path;
}

/**
 * Pure cascade decision from probe results. Order is locked: enclosing-project
 * → enclosing-git-repo → target-non-empty → free. First match wins.
 *
 * `confirm-git` fires whenever an enclosing git working tree exists — including
 * when the parent IS the git root. The new target folder (`<parent>/<name>`)
 * still lives inside the git tree, so `.ok/config.yml` lands at the git root
 * (one level UP from the target) and content.dir defaults to the git root.
 * The user should be told about this in both shapes ("parent is below git
 * root" AND "parent IS the git root") because the on-disk consequence is
 * identical.
 */
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

/**
 * Parse a thrown IPC error message into a structured create-new failure.
 * Electron strips Error subclasses across the IPC boundary — the main-side
 * `CreateNewProjectError`'s `reason` arrives only in `err.message` text. The
 * handler formats messages as `<reason>: <detail>` (e.g.
 * `"nested-project: Cannot create a project inside an existing project: /foo"`)
 * so a string-prefix match recovers the reason.
 */
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

/** Human-friendly inline error copy for the toast strip. */
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
  // Parent directory the new project will be created under. Hydrated on open
  // from `bridge.fs.defaultProjectsRoot()` (last-used parent, else
  // `~/Documents/OpenKnowledge`); displayed read-only. Browse picks a fresh
  // parent; the path is never user-edited as free text.
  const [location, setLocation] = useState('');
  // Whether the on-open `defaultProjectsRoot()` probe is still in flight. Lets
  // the read-only display tell "still resolving" (transient hint) apart from
  // "resolved but empty" (the probe rejected) so a rejection shows actionable
  // empty-state copy instead of a resolving hint that never clears.
  const [locationResolving, setLocationResolving] = useState(false);
  // Project name typed into the always-present <Input>. The creation target
  // is `joinPathPreview(location, sanitizeFolderName(name))`.
  const [name, setName] = useState('');
  // Tools detected on this machine that also have a project surface, probed on
  // each open. `null` means the probe is still in flight — distinct from `[]`
  // ("probed, found nothing"), because the row is always visible now and has to
  // say which of the two it is rather than flashing an empty state.
  const [detectedEditors, setDetectedEditors] = useState<readonly OkMcpWiringEditorId[] | null>(
    null,
  );
  // Whether to wire those tools on submit. One decision, pre-checked: the write
  // set is exactly the detected tools, so there is nothing to seed and no race
  // with the probe — a late result changes the list the label names, never the
  // answer the user gave.
  const [connectEditors, setConnectEditors] = useState(true);
  // OK config sharing mode, rendered via SharingModeField at the top level.
  // There is no `gitState === 'absent'` carve-out here because Create-new
  // always runs `ensureProjectGit` (step 6 of runCreateNew), so the gitdir is
  // guaranteed to exist by the time the sharing transition runs.
  const [sharing, setSharing] = useState<SharingMode>(DEFAULT_SHARING_MODE);
  // Starter-pack selection + where it scaffolds. `packId` starts at the
  // launcher's pick and can be changed in-dialog (step 'pick'); the root
  // defaults to the project root — same default the in-project seed dialog
  // uses — with the pack's `defaultSubfolder` only pre-filling the input.
  const [packId, setPackId] = useState<OkPackId | undefined>(initialPackId);
  // `review` sits between picking a pack and configuring the project: it is the
  // only place the pack's manifest renders, so the configure screen carries
  // nothing the user cannot act on. A blank create never enters either pack
  // step.
  const [step, setStep] = useState<CreateStep>('configure');
  const [rootChoice, setRootChoice] = useState<SeedRootChoice>('project-root');
  const [subfolder, setSubfolder] = useState('');
  const [packPreview, setPackPreview] = useState<PackPreview>({ kind: 'loading' });
  // Reduced to a boolean so the open effect can depend on "is there a pack list"
  // without depending on the array itself.
  const hasPackList = (packs?.length ?? 0) > 0;
  // Whether the caller's pack id actually resolves, not merely that one was
  // passed. An unresolved id would open on review, where the body falls through
  // to the configure form (it needs `selectedPack`) while the footer still
  // branches on the step — a form wearing the review screen's buttons. Reduced
  // to a boolean for the same reason as above: the open effect must not
  // re-trigger on a new `packs` array identity.
  const initialPackResolves =
    initialPackId !== undefined && (packs?.some((pack) => pack.id === initialPackId) ?? false);
  // Same trick for the preview gate: review and configure both want a plan, so
  // moving between them must not tear the effect down and re-issue a byte
  // identical round trip.
  const packPlanActive = step !== 'pick';
  // A settled plan is the only place the pack's skill count exists, and it is
  // read three times below. `kind === 'plan'` already implies a selected pack —
  // the preview effect returns early without one.
  const packSkillCount =
    packPreview.kind === 'plan' ? (packPreview.plan.packSkills?.length ?? 0) : 0;
  const [cascade, setCascade] = useState<SettledCascade>({ kind: 'idle' });
  const [probeLifecycle, setProbeLifecycle] = useState<ProbeLifecycle>('idle');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<CreateNewError | null>(null);
  const [removeGitState, setRemoveGitState] = useState<RemoveGitState>({ kind: 'idle' });
  // Monotonic counter that's a dep of the cascade-probe useEffect. Bumped
  // by the window-focus listener, the 5 s confirm-git poll, the
  // remove-.git success handler, and Browse-success — anything that needs
  // to force a fresh live probe without changing form fields. The Browse
  // bump is load-bearing: a same-parent re-pick (`setLocation(location)`
  // with the same value) bails out of React render scheduling, so without
  // the nonce bump no fresh probe would fire and the banner could remain
  // stale across an external FS mutation. Not reset on open (re-open
  // simply continues incrementing; bump-to-bump deltas are what React's
  // deps comparison cares about, not absolute values).
  const [probeNonce, setProbeNonce] = useState(0);

  // Per-dialog-open dedupe + IPC plumbing. Cleared on each open (re-mount path
  // would also work, but the same dialog instance is reused across opens).
  const firedBanners = useRef<Set<CreateNewBannerKind>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const reviewContinueRef = useRef<HTMLButtonElement | null>(null);
  const packGridRef = useRef<HTMLDivElement | null>(null);

  // Route every in-dialog step change through here so "changed step without
  // handing off focus" is not expressible. The on-open effect is the one
  // exception: it seeds the whole form and owns its own frame cancellation, so
  // it calls `focusStepPrimary` directly.
  const goToStep = (next: CreateStep) => {
    setStep(next);
    requestAnimationFrame(() =>
      focusStepPrimary(next, { reviewContinueRef, nameInputRef, packGridRef }),
    );
  };
  // Monotonic ID for in-flight remove-.git IPC calls. The post-IPC handler
  // checks this against its captured-at-dispatch value; any completion for a
  // superseded call (gitRoot changed under us, or the user opened a fresh
  // confirmation) is discarded silently rather than landing on stale state
  // the user can't see (the error panel only renders inside the confirm-git
  // banner, so a result that arrives after the banner has moved on would
  // otherwise be lost without UX feedback).
  const removeGitCallIdRef = useRef(0);
  // Whether the next pack-preview plan is the first of this open cycle — it
  // fires immediately, later ones debounce. Reset on open and whenever the
  // user picks a different pack.
  const previewFirstLoadRef = useRef(true);

  // Hydrate Location + focus the Name input on dialog open. Reset transient
  // state (banner-fired set, error, busy, name, editors, removeGitState) so
  // a re-open is a clean slate. `busy` in particular MUST reset: the success
  // path closes the dialog without clearing it, so without this reset the
  // next open finds every input disabled and the dialog dead until the
  // window is killed. `name` resets so a fresh open does not carry over a
  // previous open's typed name; `location` re-hydrates from defaultRoot so
  // it picks up the persisted last-used parent on each open.
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
    // Honor the caller's pack on every open — the Navigator clears it when the
    // dialog closes, so a blank create after a pack create must not inherit it.
    setPackId(initialPackId);
    // Which screen the dialog opens on is inferred from what the caller handed
    // it, so no call site has to name a step. A pack means the user already
    // chose one and lands on review; a pack list with no pack is the browse-all
    // entry and lands on the grid; neither is a blank create, which has no pack
    // screens at all. `hasPackList` is the dependency rather than `packs` so a
    // new array identity from the parent cannot reset the whole form mid-open.
    const openingStep = initialPackResolves ? 'review' : hasPackList ? 'pick' : 'configure';
    setStep(openingStep);
    setRootChoice('project-root');
    setPackPreview({ kind: 'loading' });
    previewFirstLoadRef.current = true;
    // Invalidate any in-flight removeGitFolder IPC from a previous open
    // (dialog component is reused, useRef survives) so its completion
    // can't land on the fresh-open state.
    removeGitCallIdRef.current += 1;

    let cancelled = false;
    // Re-probe detection on every open (the user may have installed a tool
    // since last time). Filtered to the tools this create will actually write
    // something for — `receivesProjectIntegrationWrite`, not mere surface
    // membership. A user-global-only tool has nothing to write; Copilot has a
    // project skill root but its skill is gated on Copilot's user-global
    // OpenKnowledge entry, so before that exists the write lands as
    // `skipped-prerequisite`. Naming either in the checkbox label would promise
    // a file that never appears.
    bridge.integrations
      .status()
      .then((status) => {
        if (cancelled) return;
        // `installed` only — deliberately stricter than the write path's own
        // check, which asks whether ANY entry sits under OpenKnowledge's server
        // name and so also passes on `foreign` (an entry under that name that
        // isn't ours). A foreign entry means OK's MCP is not actually
        // registered, so the skill would tell the agent to call tools that
        // aren't there. Erring strict costs a Copilot user with a foreign entry
        // nothing they were promised; erring loose would name a tool whose
        // setup does not work.
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
        // Best-effort: settle on an empty list so we never create a host root
        // for a tool we could not confirm, and the row says so rather than
        // hanging on "Checking…".
        console.warn('[CreateProjectDialog] editor-detection probe failed:', err);
        if (!cancelled) setDetectedEditors([]);
      });

    // Reset Location before refetching — second-open after a first-open
    // success leaves a stale value visible if defaultProjectsRoot() rejects
    // this time. The catch handler's "leave location empty on failure"
    // guarantee only holds when the slot was empty going in. Browse is
    // always usable from an empty Location.
    setLocation('');
    setLocationResolving(true);
    bridge.fs
      .defaultProjectsRoot()
      .then((root) => {
        if (!cancelled) setLocation(root);
      })
      .catch((err) => {
        // Best-effort: leave Location empty on failure. Browse can still
        // mint a parent. The bridge surface never rejects on happy paths
        // today, so this branch is paranoia not policy — but log so triage
        // has a breadcrumb when an unhappy path lands.
        console.warn('[CreateProjectDialog] defaultProjectsRoot probe failed:', err);
      })
      .finally(() => {
        // Probe settled (resolved or rejected). On rejection `location` stays
        // empty, so clearing this flag is what swaps the resolving hint for
        // the actionable empty-state copy; on success `location` is non-empty
        // and the flag no longer gates the display.
        if (!cancelled) setLocationResolving(false);
      });

    // Move focus to the screen's primary control once shadcn Dialog finishes
    // its mount animation. requestAnimationFrame defers past the initial
    // render so Radix's portal/transition handlers don't steal focus back.
    //
    // The target has to follow the step chosen above: each screen mounts a
    // different body, so a ref belonging to another screen is null here and
    // `?.focus()` silently no-ops — leaving Radix to take the first tabbable
    // node in DOM order. On review that is `Change pack`, which discards the
    // pack the user just chose, so the no-op is not a harmless one.
    const raf = requestAnimationFrame(() =>
      focusStepPrimary(openingStep, { reviewContinueRef, nameInputRef, packGridRef }),
    );

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
    // Caller contract: `packs` must be settled before `open` goes true. These
    // are booleans rather than the array so a re-fetch returning an equal list
    // cannot re-run this, but a genuine empty→populated flip mid-open still
    // would — and this effect resets the whole form, so it would wipe input.
  }, [open, bridge, initialPackId, hasPackList, initialPackResolves]);

  // The pack currently configured, resolved from the caller-supplied list.
  // Absent when this is a blank create (no `packId`) or when the caller didn't
  // pass `packs` — both cases render no pack UI at all.
  const selectedPack = packs?.find((pack) => pack.id === packId);

  // Pre-fill the subfolder field from the selected pack's default. Packs with
  // no `defaultSubfolder` clear it, so switching from `brain/` to a pack
  // without one doesn't leave a stale value behind. The field is only a
  // pre-fill — the scaffold still lands at the project root unless the user
  // picks "In a subfolder".
  //
  // Keyed on `open` and the default VALUE rather than the pack object: a name
  // typed into a cancelled attempt must not survive into the next open, and
  // the caller may hand back the very same pack object (its pack list is
  // fetched once and reused), so object identity alone would not re-fire this.
  const selectedPackSubfolderDefault = selectedPack?.defaultSubfolder ?? '';
  useEffect(() => {
    // `open` is a "re-run me on reopen" signal, not a value the body reads —
    // same shape as `probeNonce` below.
    void open;
    if (packId === undefined) return;
    setSubfolder(selectedPackSubfolderDefault);
  }, [open, packId, selectedPackSubfolderDefault]);

  const trimmedSubfolder = subfolder.trim();
  const subfolderInvalid =
    selectedPack !== undefined && rootChoice === 'subfolder' && trimmedSubfolder === '';
  const packRootDir = rootChoice === 'project-root' ? undefined : trimmedSubfolder;
  // The pack's skills install only into editors this project is set up for,
  // and `runCreateNew` writes those integrations before it seeds — so declining
  // the AI-tool setup (or finding no tool to set up) means no skill lands, and
  // the preview must say so.
  const skillsInstallable = connectEditors && (detectedEditors?.length ?? 0) > 0;

  // Live pack preview. Re-plans on every input that changes what would be
  // written; nothing here touches disk (main plans against a throwaway dir).
  useEffect(() => {
    if (!open) return;
    if (selectedPack === undefined) return;
    // Runs on review and configure alike: review is where the plan is read, and
    // configure keeps re-planning as the root/subfolder and AI-tool inputs
    // change. Only the grid has no pack to plan for.
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
      // Only show the skeleton when nothing is on screen yet — keeps the list
      // steady while the user is still typing a subfolder name.
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
          // `invalid-root` is the one kind the user can fix by editing the
          // field, and the one that would otherwise produce a silently
          // unseeded project. Its message names what is wrong with the input,
          // so it is worth showing; anything else is an internal string
          // (`ENOENT …`, `Error invoking remote method …`) that tells the user
          // nothing they can act on. The detail goes to the console instead.
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
            // A rejected transport is not something the user can fix by
            // editing the form, so it must not withhold Create.
            blocking: false,
          });
        });
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, packPlanActive, selectedPack, packRootDir, subfolderInvalid, skillsInstallable, t]);

  // Cascade probe — debounce + abort. Recomputes on every `location` or
  // `name` change. When either is empty (or `name` sanitizes to empty),
  // snap to idle immediately. The probe target is the path the server-side
  // handler will resolve: `joinPathPreview(location, sanitized)`.
  useEffect(() => {
    // `probeNonce` is read here only to satisfy biome's
    // `useExhaustiveDependencies` — it's a "re-run me" signal, not a
    // value the body needs. Bumped by window-focus, the 5 s confirm-git
    // poll, remove-.git success, and onBrowse success (same-parent re-pick
    // must re-probe).
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
    // Probe `joinPathPreview(parent, sanitized)` — the actual creation
    // target. The server-side handler builds the project at `resolve(parent,
    // sanitizeFolderName(name))`, so a folderState probe against the raw
    // typed name silently checks a different folder than the one
    // `runCreateNew` will land at whenever `sanitizeFolderName` rewrites
    // it (leading-dot names are the simplest reproducer).
    const target = joinPathPreview(parent, sanitized);

    // `cascade` stays at its current verdict so the banner DOM remains
    // mounted with stable layout while we re-check; only `probeLifecycle`
    // flips, and only when an IPC is actually in-flight (see below).
    // Flipping `cascade` to a non-terminal kind here would make
    // `CascadeBanner` return null and unmount the banner subtree on every
    // probe re-run (5 s poll, window focus, name keystroke) — the
    // visible flicker this split exists to prevent.
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    debounceRef.current = setTimeout(() => {
      // Flip `in-flight` here, not before the debounce: "in-flight" means
      // an IPC is executing, not that one is scheduled. Doing it earlier
      // would briefly gate `canSubmit` on every name-input keystroke
      // (probe deps include `name`) — a per-keystroke flicker on the
      // Create button.
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
          // Treat probe failure as `free` — main-side defense-in-depth
          // re-runs every check on submit; user can still get a useful
          // failure message there if the probes were transiently failing.
          // Log so a user-reported "cascade said free but submit threw"
          // has an audit trail before the IPC reply.
          console.warn('[CreateProjectDialog] cascade probe failed:', err);
          setProbeLifecycle('idle');
          setCascade({ kind: 'free' });
        });
    }, PROBE_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      ctrl.abort();
    };
    // probeNonce in deps so external triggers (window focus, 5 s poll,
    // remove-.git success, same-parent re-pick via onBrowse) can force a
    // fresh probe without touching form fields. The handler itself ignores
    // probeNonce — it's a pure re-render driver.
  }, [open, location, name, bridge, probeNonce]);

  // Window-focus re-probe. Catches the "user switched to Finder / Terminal,
  // mutated the FS (e.g. deleted the offending .git), came back" path that
  // form-change-only probing misses. Listener is attached only while the
  // dialog is open; bare `window.focus` is enough — Electron `BrowserWindow`
  // focus propagates through the renderer's window naturally.
  useEffect(() => {
    if (!open) return;
    const onFocus = () => setProbeNonce((n) => n + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [open]);

  // 5 s polling re-probe, ONLY while the confirm-git banner is showing.
  // Self-heals when the user resolves the .git externally; doesn't burn
  // cycles in any other cascade state. Asymmetric on purpose — we don't
  // poll to discover a newly-appearing .git, only to confirm one is gone.
  //
  // The interval reads `probeLifecycle` via a ref so it can skip the
  // probeNonce bump while a probe is already in-flight. Without this skip,
  // the polling's `setProbeNonce` re-runs the cascade-probe useEffect — the
  // cleanup function aborts the in-flight probe and clears its debounce
  // timer before it ever fires, so the in-flight verdict is lost. Under the
  // previous unified-state shape this was harmless (the in-flight render
  // had cascade='pending' which itself unmounted the banner, so a cancelled
  // probe just delayed the eventual settle-to-terminal). Under the
  // SettledCascade + ProbeLifecycle split the banner stays mounted with its
  // previous terminal verdict during in-flight, so a cancelled probe would
  // leave the banner stuck on a stale verdict. The ref lets the interval
  // check current lifecycle without re-creating itself every time
  // probeLifecycle flips.
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

  // Reset the remove-.git inline confirmation whenever the targeted gitRoot
  // changes (or the banner goes away). Without this, a user who removes one
  // `.git`, sees the banner repaint with the next-higher `.git`, and clicks
  // would be stuck on stale "confirming /old/path" copy. Bumping
  // `removeGitCallIdRef` invalidates any in-flight removeGitFolder IPC for
  // the now-stale gitRoot so its completion can't land on the new state.
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

  // Fire-once-per-dialog-open banner telemetry. Driven off cascade state so
  // the dedupe set in `firedBanners` survives the user's clear-and-retype
  // round-trips.
  useEffect(() => {
    if (!open) return;
    let banner: CreateNewBannerKind | null = null;
    if (cascade.kind === 'block-nested') banner = 'nested';
    else if (cascade.kind === 'block-nonempty') banner = 'nonempty';
    else if (cascade.kind === 'confirm-git') banner = 'git-confirm';
    if (banner === null) return;
    if (firedBanners.current.has(banner)) return;
    firedBanners.current.add(banner);
    bridge.project.recordCreateNewBannerShown(banner).catch(() => {
      // Telemetry must never fail user flows — swallow + continue.
    });
  }, [open, cascade, bridge]);

  // Derived name + target presentation.
  const rawName = name;
  const sanitized = rawName === '' ? '' : sanitizeFolderName(rawName);
  // Sanitize-divergence: the user-provided name is filesystem-valid but the
  // conservative sanitizer rewrites some characters (leading dot,
  // whitespace, unusual unicode). Non-blocking — submit still proceeds with
  // the sanitized name; we just surface the divergence inline.
  const sanitizeDiverged = rawName !== '' && sanitized !== rawName && sanitized !== '';
  // Sanitize-erased: the typed name is composed entirely of characters the
  // sanitizer strips (leading-dot / dash / whitespace runs). The dialog
  // can't derive a non-empty project identifier; Submit is disabled and
  // the cascade snaps to idle.
  const sanitizeErased = rawName !== '' && sanitized === '';
  const nameTaken = cascade.kind === 'block-nonempty';
  // What the user will see at the resolved target — same path the server
  // creates at via `resolve(parent, sanitized)`. Hidden when empty.
  const targetPreview =
    location !== '' && sanitized !== '' ? joinPathPreview(location, sanitized) : '';
  const canSubmit =
    !busy &&
    location !== '' &&
    rawName !== '' &&
    sanitized !== '' &&
    !subfolderInvalid &&
    // A rootDir the planner rejects (`../x`, `/x`) is non-empty, so
    // `subfolderInvalid` passes it through. Seeding is best-effort main-side —
    // the error is swallowed to a warn — so submitting here would open a
    // project with no pack and nothing said. Withhold Create instead, the way
    // the in-project dialog withholds Initialize outside `phase.kind: 'plan'`.
    // Only for `blocking` errors: a preview that could not be computed at all
    // must not stop someone from creating the project.
    (selectedPack === undefined || packPreview.kind !== 'error' || !packPreview.blocking) &&
    probeLifecycle === 'idle' &&
    (cascade.kind === 'free' || cascade.kind === 'confirm-git');
  // Keep Create enabled while no name is typed yet — a disabled button
  // gives no hint why, so instead a click surfaces a guidance toast
  // ("Enter a project name", see onSubmit). Genuinely-blocked states
  // (in-flight probe, blocking cascade, unusable name) stay disabled
  // because they already render inline feedback that explains the block.
  //
  // The detection probe is one of those blocks. It settles independently of the
  // location/cascade probes, so Create can otherwise unlock while
  // `detectedEditors` is still null — and submitting then sends `editors: []`,
  // creating a project wired to nothing while the row still says "Checking
  // which AI tools you have". Only gate it while the user actually intends to
  // connect: with the box unchecked the list is never read, so there is nothing
  // to wait for. The row's own status text explains the wait.
  const detectionPending = connectEditors && detectedEditors === null;
  const submitDisabled = busy || detectionPending || (rawName !== '' && !canSubmit);

  async function onBrowse() {
    try {
      // Pass the current location so the OS picker opens at the
      // already-chosen parent. When empty (rare: defaultProjectsRoot
      // rejected and the user hasn't picked yet), omit so the OS picks
      // its own default.
      const pickedParent = await bridge.dialog.openFolder(
        location !== '' ? { defaultPath: location } : undefined,
      );
      if (pickedParent === null) return;
      setLocation(pickedParent);
      // Same-parent re-pick: `setLocation(pickedParent)` with an identical
      // value bails out of React scheduling, so the cascade-probe effect
      // would not re-fire even though the user explicitly asked for a
      // fresh probe by re-Browsing. Bumping `probeNonce` forces the
      // effect to re-run regardless of `location`'s value-equality.
      setProbeNonce((n) => n + 1);
      // Clear any stale submit error from a prior attempt — Browse picks a
      // fresh parent, so the previous attempt is no longer relevant.
      setSubmitError(null);
    } catch (err) {
      // User-cancel returns null (handled above); this branch is real IPC
      // failure — disconnected main, dialog-handler crash, etc. Leave the
      // location at its previous value (user can retry Browse) and log so
      // triage has a breadcrumb.
      console.warn('[CreateProjectDialog] dialog.openFolder failed:', err);
    }
  }

  async function onSubmit(e: React.SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    e.preventDefault();
    if (busy) return;
    // No name typed yet: the button stays enabled (see `submitDisabled`)
    // precisely so this click can explain the requirement instead of the
    // button sitting disabled with no hint.
    if (rawName.trim() === '') {
      toast.error(t`Enter a project name`);
      nameInputRef.current?.focus();
      return;
    }
    if (!canSubmit) return;
    setBusy(true);
    setSubmitError(null);
    try {
      // Renderer presents the sanitized form so the caption matches the
      // server-side target; main re-applies `sanitizeFolderName`
      // defense-in-depth, so passing the raw typed name through is also
      // safe — but we pass `sanitized` to match what the user just saw.
      await bridge.project.createNew({
        parent: location,
        name: sanitized,
        editors: connectEditors ? [...(detectedEditors ?? [])] : [],
        sharing,
        // Seed the chosen starter pack (packs-forward first-run). Undefined on
        // the blank-create path — main opens an empty project as before.
        packId,
        // Undefined means the project root, which is the default here.
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
      // Discard completion for a superseded call — `cascade.gitRoot` has
      // shifted out from under us (poll-driven re-probe arrived during the
      // IPC round-trip, user opened a fresh confirmation, etc.). The fresh
      // probe will paint authoritative state; this completion's success or
      // failure is no longer relevant.
      if (removeGitCallIdRef.current !== callId) return;
      // Force a fresh cascade probe. If a higher .git exists, the banner
      // repaints with that gitRoot (and the user can click again to climb).
      // If none does, the cascade transitions to `free` and the banner
      // disappears. The cascade-change effect resets removeGitState to
      // `idle` automatically when gitRoot shifts or the banner clears.
      setProbeNonce((n) => n + 1);
      setRemoveGitState({ kind: 'idle' });
    } catch (err) {
      if (removeGitCallIdRef.current !== callId) return;
      const message = err instanceof Error ? err.message : String(err);
      // Destructive-action failure — error not warn. The user clicked a
      // destructive button expecting it to succeed; failure is a real
      // problem and should land at the level a triager filters on.
      console.error('[CreateProjectDialog] bridge.fs.removeGitFolder failed:', err);
      setRemoveGitState({ kind: 'error', message });
    }
  }

  async function onOpenNested(rootPath: string) {
    // Close optimistically — the user's intent ("close this dialog and take
    // me to that project") is satisfied at click time. The IPC call to
    // open the editor window can take seconds to complete (Hocuspocus boot,
    // window construction); awaiting before closing leaves the dialog
    // visible during that window and races the Navigator's
    // close-on-project-open teardown.
    onOpenChange(false);
    try {
      await bridge.project.open({
        path: rootPath,
        target: 'new-window',
        entryPoint: 'create-new-nested-redirect',
      });
    } catch (err) {
      // Failure UX is the same as before — the catch site only logged. The
      // banner is gone (dialog closed), but the Navigator is still up so the
      // user can retry from scratch. Log so triage has a breadcrumb on real
      // IPC failure.
      console.warn('[CreateProjectDialog] project.open failed:', err);
    }
  }

  // Compose the aria-describedby for the name input. The live caption is
  // always present in the DOM (the screen-reader announces the resolved
  // path as the user types), and any field-level error / divergence hint
  // appends as a second descriptor so AT users hear both.
  const nameDescribedBy =
    sanitizeErased || nameTaken || sanitizeDiverged ? `${captionId} ${nameErrorId}` : captionId;

  // The pack grid is only reachable when the caller supplied a pack list AND
  // a pack is currently selected — the blank create paths (File → New,
  // command palette, project switcher) stay a plain create dialog.
  const canChangePack = packId !== undefined && hasPackList;
  const selectedPackName = selectedPack?.name;
  const selectedPackBlurb = selectedPack ? PACK_BLURBS[selectedPack.id] : undefined;
  // Named per step so the live region above announces where the user landed,
  // not merely that something changed.
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
        {/* Radix announces a dialog when focus enters it, once, on open. This
            dialog stays mounted and swaps its body, so without a live region a
            screen-reader user moving between steps hears only the newly focused
            control and never the screen it belongs to. Mirrors the AI-tools
            status region below. */}
        <span aria-live="polite" className="sr-only" data-testid="create-step-announcer">
          {stepAnnouncement}
        </span>

        <DialogHeader>
          <DialogTitle>{step === 'pick' ? t`Starter packs` : title}</DialogTitle>
          <DialogDescription>
            {step === 'pick'
              ? t`Each pack scaffolds your project with ready-made folders and templates.`
              : step === 'review'
                ? // On review the blurb is the wrong register: the user has
                  // already chosen, and what they need now is what the choice
                  // costs them on disk. The manifest below answers that, so the
                  // description only has to frame it.
                  t`Here's what this pack adds to your project. Nothing is written until you create the project.`
                : description}
          </DialogDescription>
        </DialogHeader>

        {step === 'pick' ? (
          <DialogBody ref={packGridRef}>
            <PackCardGrid
              packs={packs ?? null}
              onPackSelect={(id) => {
                setPackId(id);
                // The subfolder field re-defaults from the incoming pack, so a
                // pack with no default empties it. Left on "In a subfolder"
                // that reads as an empty required field, and the preview turns
                // into a BLOCKING error that review renders in place of the
                // manifest — with no field on screen to resolve it. Reset the
                // choice with the pack, matching what the open effect does.
                // Only on a real switch: re-picking the pack already selected
                // re-defaults no subfolder, so there is nothing to protect
                // against and the reset would just discard the user's choice.
                if (id !== packId) setRootChoice('project-root');
                // The user just clicked a card and expects the preview to
                // follow immediately, not after the typing debounce.
                previewFirstLoadRef.current = true;
                setPackPreview({ kind: 'loading' });
                // The card the click landed on unmounts with the grid, so
                // focus would fall to the body and a keyboard user would lose
                // their place inside the dialog.
                goToStep('review');
              }}
            />
          </DialogBody>
        ) : step === 'review' ? (
          // Total on the step, so the footer (which branches on `step` alone)
          // can never end up wrapped around the configure form. Both routes
          // into review resolve a pack by construction; if one ever did not,
          // rendering nothing is a visible gap rather than a silent hybrid.
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
                  {/* Inside an existing git repo the project is the repo, not
                      the folder being created (one project per repo), so
                      "project root" would otherwise read as the repo's top
                      level. The pack is anchored at the new folder instead —
                      say so, because the banner above only speaks about where
                      OpenKnowledge itself is set up. */}
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
                  {/* The manifest itself lives on the review screen. What stays
                      here is only the blocking case: a root the planner rejects
                      is a problem with an input on THIS screen, so its error has
                      to be readable next to the field that causes it. */}
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

              {/* AI-tool setup, always visible: it decides whether the project is
                usable from the user's agents at all, which is not an advanced
                concern. Mirrors the first-launch consent dialog — one pre-checked
                checkbox whose subtext names the write set, plus a "What changes?"
                popover with the exact files. Per-tool control lives in
                Settings > This project. */}
              <ProjectAiToolsField
                detectedEditors={detectedEditors}
                checked={connectEditors}
                onCheckedChange={setConnectEditors}
                disabled={busy}
              />

              {/* The review screen counted these skills, but whether they
                  install is decided HERE, a screen later — a pack's skills only
                  land in tools the project is connected to. Without this line,
                  unticking above is a silent subtraction from a number the user
                  already read. Counts every skill the pack ships (the plan
                  keeps them listed and only flips `pending`), so the number
                  stays put and only the sentence around it changes. The off-state
                  copy names the missing *connection*, not the checkbox, because
                  it covers both ways skills fail to land: the box unticked, and
                  no tool on the machine at all. The row above already tells the
                  second case what to do, so this line states only the
                  consequence rather than repeating the instruction. */}
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
          {/* One named action, one destination: "Change pack" always means the
              grid, on both screens that can reach it. The grid has no Back of
              its own — picking a pack IS the way forward out of it, and the
              form's state survives that round trip, so the non-destructive exit
              is picking rather than retreating. Its only secondary is Cancel,
              which closes because that is what Cancel means. */}
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
          {/* Cancel closes outright, from the grid as well as the form. Only a
              close resets the form — every step transition preserves what the
              user has typed. Review has no Cancel of its own; its exits are
              Change pack and the dialog's own close control. */}
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

interface ProjectAiToolsFieldProps {
  /** `null` while the detection probe is in flight; `[]` once it settled empty. */
  detectedEditors: readonly OkMcpWiringEditorId[] | null;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled: boolean;
}

/**
 * The project's AI-tool decision: one checkbox covering every detected tool,
 * with a "What changes?" popover naming the exact project-relative files it
 * writes — the same card shape and disclosure the first-launch setup rows use.
 *
 * The paths come from the same two core maps the project writer resolves its
 * targets from (`EDITOR_PROJECT_CONFIG_PATH`, `EDITOR_PROJECT_SKILL_ROOT`), so
 * the disclosure cannot advertise a file that never gets written. Tools with a
 * null entry in both are filtered out upstream and never reach this component.
 */
function ProjectAiToolsField({
  detectedEditors,
  checked,
  onCheckedChange,
  disabled,
}: ProjectAiToolsFieldProps) {
  const { t } = useLingui();
  const checkboxId = useId();

  // The probe's two non-interactive outcomes share ONE live region that is
  // always mounted. A region that appears at the same moment as its text is not
  // a change to announce — assistive tech has to be observing the node before
  // the content lands — so swapping the message inside a persistent node is what
  // makes "checking…" → "none found" actually reach a screen reader.
  const status =
    detectedEditors === null
      ? { kind: 'probing' as const, message: t`Checking which AI tools you have` }
      : detectedEditors.length === 0
        ? {
            kind: 'none' as const,
            message: t`No AI tools detected yet. Once you install one, connect it from Settings > This project.`,
          }
        : // Carrying the narrowed list on the ready arm is what lets the early
          // return below discriminate it — the guard alone doesn't re-narrow
          // `detectedEditors` for the JSX that follows.
          { kind: 'ready' as const, message: '', editors: detectedEditors };

  const statusRegion = (
    <p
      aria-live="polite"
      className={cn(
        status.kind === 'ready'
          ? 'sr-only'
          : 'rounded-md border border-border px-3 py-2.5 text-1sm text-muted-foreground',
      )}
      data-status={status.kind}
      data-testid="create-editors-status"
    >
      {status.message}
    </p>
  );

  if (status.kind !== 'ready') return statusRegion;

  // Named local so the `t` macro extracts `{toolList}` rather than a
  // positional placeholder for the inline call expression.
  const toolList = formatToolList(
    status.editors.map((id) => EDITOR_LABELS[id]),
    i18n.locale,
  );

  return (
    <>
      {/* Stays mounted (visually hidden, empty) so the region survives every
        transition rather than being torn down when the checkbox appears. */}
      {statusRegion}
      {/* Same card anatomy as the first-launch setup rows: checkbox + title on
        the first line, subtext indented under the title (checkbox size-4 = 1rem
        + gap-2.5 = 0.625rem), and the "What changes?" disclosure absolutely
        placed on the first line (needs `relative` here; the title's `pe-28`
        keeps long labels from running under it). */}
      <div className="relative overflow-hidden rounded-lg border border-border bg-card/50 px-4 py-3 hover:bg-accent">
        <Label
          htmlFor={checkboxId}
          className="flex min-w-0 cursor-pointer flex-col items-start gap-1 font-normal"
        >
          <span className="flex w-full items-center gap-2.5">
            <Checkbox
              id={checkboxId}
              checked={checked}
              onCheckedChange={() => onCheckedChange(!checked)}
              disabled={disabled}
              data-testid="create-editors-checkbox"
            />
            {/* Fixed-length title: the detected-tool list goes in the subtext
              below instead, so a machine with many tools can't wrap this line
              and push the "What changes?" button out of alignment. */}
            <span
              className="flex min-w-0 flex-1 items-center gap-1.5 pe-28 text-sm font-medium text-foreground"
              data-testid="create-editors-title"
            >
              <Trans comment="Checkbox that wires the OpenKnowledge MCP into every detected AI tool for the new project">
                Connect your AI tools to this project
              </Trans>
            </span>
          </span>
          {/* Consent integrity: the write set is named here, in always-visible
            text — moving it off the title line must not move it behind the
            "What changes?" disclosure. */}
          <span
            className="text-1sm leading-normal ps-6.5 text-muted-foreground"
            data-testid="create-editors-summary"
          >
            {/* Tool names carry the emphasis: they are the part of this
              sentence that differs per machine, and the rest is boilerplate.
              Wording tracks the first-launch dialog's MCP row — same promise,
              plus the project skill this surface also writes. */}
            <Trans comment="Subtext under the create-project AI-tools checkbox">
              Adds an OpenKnowledge MCP entry and the project skill to{' '}
              <span className="font-medium text-foreground">{toolList}</span>, so your agents can
              read and edit your files.
            </Trans>
          </span>
        </Label>
        <RowDisclosure title={t`Adds these files`} testId="create-editors-details-toggle">
          {/* A real list: this is an enumeration of files per tool, and screen
            readers announce item counts and offer list navigation for it. */}
          <ul className="flex flex-col gap-2" data-testid="create-editors-details">
            {status.editors.map((id) => {
              const configPath = EDITOR_PROJECT_CONFIG_PATH[id];
              const skillRoot = EDITOR_PROJECT_SKILL_ROOT[id];
              return (
                <li key={id} className="flex min-w-0 flex-col" data-testid={`create-editor-${id}`}>
                  <span className="font-medium">{EDITOR_LABELS[id]}</span>
                  {configPath !== null && (
                    <span className="wrap-break-word opacity-75">
                      <code className="break-all">{configPath}</code>
                    </span>
                  )}
                  {skillRoot !== null && (
                    <span className="wrap-break-word opacity-75">
                      <code className="break-all">{`${skillRoot}/${RESERVED_PROJECT_SKILL_NAME}/`}</code>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </RowDisclosure>
      </div>
    </>
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
  // `block-nonempty` is rendered inline as a Name-field error, not as a
  // banner — the field-local error sits where the fix lives. The cascade
  // value itself still drives the telemetry effect.
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
    // Named local so the failure `<Trans>` extracts `{removeGitError}`
    // rather than a positional placeholder for the member expression.
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
  // All `SettledCascade` variants are handled above, narrowing `cascade` to
  // `never` here. A new variant added without a UI branch fails this
  // assignment at compile time.
  const _exhaustive: never = cascade;
  void _exhaustive;
  return null;
}

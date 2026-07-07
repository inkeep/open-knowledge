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
 * shows the resolved target before submit. The config-sharing posture
 * (side-by-side radio cards) and the editor-checkbox group (all default ON)
 * both collapse under an "Advanced settings" section. Cancel +
 * Create footer. Create stays enabled with an empty name — a click then
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

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bridge: OkDesktopBridge;
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

export function CreateProjectDialog({ open, onOpenChange, bridge }: CreateProjectDialogProps) {
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
  const [editorIds, setEditorIds] = useState<ReadonlySet<OkMcpWiringEditorId>>(
    () => new Set(ALL_EDITOR_IDS),
  );
  // OK config sharing mode. Defaults to `'shared'` (encourages team
  // adoption). Rendered via SharingModeField inside "Advanced settings" — the
  // greenfield dialog tucks the choice away (sensible default already set),
  // unlike the open-folder consent dialog which surfaces it at the top level.
  // There is no `gitState === 'absent'` carve-out here because Create-new
  // always runs `ensureProjectGit` (step 6 of runCreateNew), so the gitdir is
  // guaranteed to exist by the time the sharing transition runs.
  const [sharing, setSharing] = useState<'shared' | 'local-only'>('shared');
  // Editor controls and the sharing posture collapse under "Advanced settings"
  // so the dialog leads with just the name and location fields. Reset closed
  // on each open.
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
  // Monotonic ID for in-flight remove-.git IPC calls. The post-IPC handler
  // checks this against its captured-at-dispatch value; any completion for a
  // superseded call (gitRoot changed under us, or the user opened a fresh
  // confirmation) is discarded silently rather than landing on stale state
  // the user can't see (the error panel only renders inside the confirm-git
  // banner, so a result that arrives after the banner has moved on would
  // otherwise be lost without UX feedback).
  const removeGitCallIdRef = useRef(0);

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
    setEditorIds(new Set(ALL_EDITOR_IDS));
    setSharing('shared');
    setAdvancedOpen(false);
    setRemoveGitState({ kind: 'idle' });
    // Invalidate any in-flight removeGitFolder IPC from a previous open
    // (dialog component is reused, useRef survives) so its completion
    // can't land on the fresh-open state.
    removeGitCallIdRef.current += 1;

    let cancelled = false;
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

    // Focus the Name input once shadcn Dialog finishes its mount
    // animation. requestAnimationFrame defers past the initial render so
    // Radix's portal/transition handlers don't steal focus back. The name
    // input is always rendered (no defaultPath-loading gate), so `.focus()`
    // lands on a real focusable input regardless of where the
    // defaultProjectsRoot promise is in its lifecycle.
    const raf = requestAnimationFrame(() => {
      nameInputRef.current?.focus();
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [open, bridge]);

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
    probeLifecycle === 'idle' &&
    (cascade.kind === 'free' || cascade.kind === 'confirm-git');
  // Keep Create enabled while no name is typed yet — a disabled button
  // gives no hint why, so instead a click surfaces a guidance toast
  // ("Enter a project name", see onSubmit). Genuinely-blocked states
  // (in-flight probe, blocking cascade, unusable name) stay disabled
  // because they already render inline feedback that explains the block.
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

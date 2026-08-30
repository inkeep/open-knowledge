/**
 * Desktop self-uninstall orchestration.
 *
 * The running Electron process must not delete its own `.app` bundle. Instead
 * main shows the confirmation UI, runs the bundled CLI cleanup while displaying
 * progress (`ok deinit` for explicitly selected projects, then
 * `ok uninstall --yes` for the global footprint), and finally reveals
 * OpenKnowledge.app in Finder so the user can drag it to the Trash.
 *
 * Electron-free + dependency-injected so the path predicates, the flow
 * decisions, and the generated helper script are unit-testable without an
 * Electron runtime.
 */

import { spawn as spawnChild } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  hasUninstallFeedbackContent,
  isUninstallFeedbackReason,
  postUninstallFeedback,
  UNINSTALL_FEEDBACK_EMAIL_MAX_LEN,
  UNINSTALL_FEEDBACK_NOTE_MAX_LEN,
  type UninstallFeedbackAnswers,
  type UninstallFeedbackResult,
  type UninstallFeedbackSubmission,
} from '@inkeep/open-knowledge-core';

const APP_BUNDLE_FROM_EXEC_RE = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/;
const SUPPORTED_APP_BUNDLE_NAME = 'OpenKnowledge.app';

export interface DesktopUninstallProjectCandidate {
  path: string;
  open: boolean;
  recent: boolean;
  running: boolean;
}

export interface CollectDesktopUninstallProjectCandidatesInput {
  recentProjects: ReadonlyArray<{ path: string }>;
  openProjectPaths: readonly string[];
  /** Server lock dirs (`<project>/.ok/local`) discovered before the app quits. */
  lockDirs: readonly string[];
  exists?: (path: string) => boolean;
}

export interface DesktopUninstallCleanupInput {
  cliPath: string;
  projectPaths: readonly string[];
  logPath: string;
}

interface SpawnedCleanupChildLike {
  once(event: 'error', listener: (err: Error) => void): void;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

interface RunDesktopUninstallCleanupDeps {
  spawn?: (command: string, args: readonly string[], options: object) => SpawnedCleanupChildLike;
}

export type RunDesktopUninstallCleanupResult =
  | { ok: true }
  | { ok: false; error: string; exitCode?: number | null };

/** Preview modes that walk the whole uninstall flow with cleanup stubbed out. */
export type DesktopUninstallFlowPreviewMode = 'success' | 'failure';

/**
 * Modes that open one screen instead of walking the flow, so a screen can be
 * exercised without any of the destructive steps behind it.
 *
 * `'renderer'` opens the React uninstall window on a notice — the surface the
 * font/theme/token smoke asserts against. `'picker'` opens the project picker
 * over illustrative candidates and resolves without proceeding. `'survey'`
 * opens the churn survey and reports the answers back on screen instead of
 * posting them anywhere. `'notice'` walks both notice shapes — the two-button
 * question and the single-button recap — and reports how each was answered,
 * which is what makes their opposite close semantics observable.
 */
type DesktopUninstallScreenPreviewMode = 'renderer' | 'picker' | 'survey' | 'notice';

export type DesktopUninstallUiPreviewMode =
  | DesktopUninstallFlowPreviewMode
  | DesktopUninstallScreenPreviewMode;

/**
 * Resolve the dev-only uninstall UI preview mode from its env var. Returns null
 * (preview off) in a packaged build regardless of the env value, so the
 * non-destructive walkthrough can never fire in a shipped app.
 */
export function resolveDesktopUninstallUiPreviewMode(
  raw: string | undefined,
  isPackaged: boolean,
): DesktopUninstallUiPreviewMode | null {
  if (isPackaged) return null;
  if (raw === 'success' || raw === '1' || raw === 'true') return 'success';
  if (raw === 'failure' || raw === 'fail') return 'failure';
  if (raw === 'renderer') return 'renderer';
  if (raw === 'picker') return 'picker';
  if (raw === 'survey') return 'survey';
  if (raw === 'notice') return 'notice';
  return null;
}

/** Resolve `/Applications/OpenKnowledge.app` from Electron's main execPath. */
export function resolveAppBundleFromExecPath(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'darwin') return null;
  const match = execPath.match(APP_BUNDLE_FROM_EXEC_RE);
  return match?.[1] ?? null;
}

/**
 * True only for the two install locations we are willing to remove from inside
 * the app: `/Applications/OpenKnowledge.app` and `~/Applications/OpenKnowledge.app`.
 * This intentionally refuses DMG-mounted, Downloads, dev, and renamed bundles.
 */
export function isSupportedApplicationsBundle(
  bundlePath: string,
  home: string = homedir(),
): boolean {
  const app = resolve(bundlePath);
  return (
    app === join('/Applications', SUPPORTED_APP_BUNDLE_NAME) ||
    app === join(resolve(home), 'Applications', SUPPORTED_APP_BUNDLE_NAME)
  );
}

function projectRootFromLockDir(lockDir: string): string {
  return resolve(lockDir, '..', '..');
}

function addCandidate(
  candidates: Map<string, DesktopUninstallProjectCandidate>,
  path: string,
  flags: Partial<Pick<DesktopUninstallProjectCandidate, 'open' | 'recent' | 'running'>>,
): void {
  const resolved = resolve(path);
  const existing = candidates.get(resolved);
  if (existing) {
    candidates.set(resolved, { ...existing, ...flags });
    return;
  }
  candidates.set(resolved, {
    path: resolved,
    open: flags.open ?? false,
    recent: flags.recent ?? false,
    running: flags.running ?? false,
  });
}

/**
 * Desktop equivalent of `ok uninstall`'s project-candidate discovery, without
 * any prompt: open windows first, then recents, then running lock dirs. The
 * caller decides whether to include these projects; default UX leaves them out.
 */
export function collectDesktopUninstallProjectCandidates(
  input: CollectDesktopUninstallProjectCandidatesInput,
): DesktopUninstallProjectCandidate[] {
  const exists = input.exists ?? existsSync;
  const candidates = new Map<string, DesktopUninstallProjectCandidate>();

  for (const path of input.openProjectPaths) addCandidate(candidates, path, { open: true });
  for (const row of input.recentProjects) addCandidate(candidates, row.path, { recent: true });
  for (const lockDir of input.lockDirs) {
    addCandidate(candidates, projectRootFromLockDir(lockDir), { running: true });
  }

  return [...candidates.values()].filter((candidate) => exists(join(candidate.path, '.ok')));
}

/**
 * Resolve renderer-supplied indexes against main's own candidate list. Anything
 * that cannot index that list is dropped, so the widest a selection can get is
 * the set of projects main already collected — the renderer never contributes a
 * path, only a choice among paths main offered.
 */
export function selectDesktopUninstallProjectsByIndex(
  candidates: readonly DesktopUninstallProjectCandidate[],
  rawIndexes: unknown,
): DesktopUninstallProjectCandidate[] {
  const indexes = Array.isArray(rawIndexes) ? rawIndexes : [];
  const selected = new Set<number>();
  for (const value of indexes) {
    if (Number.isInteger(value) && value >= 0 && value < candidates.length) {
      selected.add(value);
    }
  }
  return candidates.filter((_, index) => selected.has(index));
}

// ---------------------------------------------------------------------------
// Churn survey answers
// ---------------------------------------------------------------------------

/**
 * Renderer text arriving at the main process: trim, drop blanks so an untouched
 * field never counts as an answer, and clamp to the intake's field limits.
 */
function boundedFeedbackAnswer(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  return trimmed.slice(0, maxLength);
}

/**
 * Turn whatever the survey screen sent into answers safe to file: trim, drop
 * blanks, and clamp. The renderer's `maxlength` and this clamp both read
 * `UNINSTALL_FEEDBACK_*_MAX_LEN`, so they cannot disagree about the intake's
 * limits.
 */
export function normalizeDesktopUninstallFeedbackAnswers(raw: unknown): UninstallFeedbackAnswers {
  const record: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {};
  const note = boundedFeedbackAnswer(record.note, UNINSTALL_FEEDBACK_NOTE_MAX_LEN);
  const email = boundedFeedbackAnswer(record.email, UNINSTALL_FEEDBACK_EMAIL_MAX_LEN);
  return {
    // A slug outside the taxonomy would file a ticket nothing can group by;
    // dropping it keeps whatever the user actually wrote.
    ...(isUninstallFeedbackReason(record.reason) ? { reason: record.reason } : {}),
    ...(note === undefined ? {} : { note }),
    ...(email === undefined ? {} : { email }),
  };
}

// ---------------------------------------------------------------------------
// Pre-cleanup confirm flow
// ---------------------------------------------------------------------------

export interface DesktopUninstallConfirmStepDeps {
  candidates: readonly DesktopUninstallProjectCandidate[];
  /** Resolves the projects to remove, or `null` when the user cancels. */
  showProjectPicker: (
    candidates: readonly DesktopUninstallProjectCandidate[],
  ) => Promise<DesktopUninstallProjectCandidate[] | null>;
  /** Plain confirmation for installs with no known projects; `false` cancels. */
  showConfirmNotice: () => Promise<boolean>;
}

export type DesktopUninstallConfirmOutcome =
  | { proceed: false }
  | { proceed: true; projectPaths: string[] };

/**
 * Everything between the menu click and the irreversible cleanup: get the
 * uninstall confirmed on whichever surface fits the install.
 *
 * The confirm surfaces are the only place an uninstall can still be called off.
 * Feedback is asked later — after a successful removal, see
 * runDesktopUninstallOutcomeStep — so the survey only reaches people who left.
 */
export async function confirmDesktopUninstall(
  deps: DesktopUninstallConfirmStepDeps,
): Promise<DesktopUninstallConfirmOutcome> {
  let projectPaths: string[] = [];
  if (deps.candidates.length > 0) {
    const selected = await deps.showProjectPicker(deps.candidates);
    if (selected === null) return { proceed: false };
    projectPaths = selected.map((candidate) => candidate.path);
  } else if (!(await deps.showConfirmNotice())) {
    return { proceed: false };
  }
  return { proceed: true, projectPaths };
}

// ---------------------------------------------------------------------------
// Post-cleanup outcome flow
// ---------------------------------------------------------------------------

export interface DesktopUninstallFeedbackStepDeps {
  /** Show the feedback screen and resolve with whatever the user left. */
  collect: () => Promise<UninstallFeedbackAnswers>;
  appVersion: string;
  platform?: string;
  /** Injectable for tests; the real transport bounds its own wait. */
  submit?: (submission: UninstallFeedbackSubmission) => Promise<UninstallFeedbackResult>;
}

export type DesktopUninstallFeedbackStepOutcome =
  | { status: 'skipped' }
  | { status: 'submitted'; result: UninstallFeedbackResult }
  | { status: 'failed'; error: unknown };

/**
 * Ask the departing user why — the removal has already succeeded by now — and
 * flush the answer before the flow reaches the finish screen and `app.quit()`:
 * a fire-and-forget POST would be killed mid-flight in a packaged build.
 *
 * The window and the transport are both outside this module, so every failure
 * comes back as an outcome instead of throwing: OpenKnowledge is already gone
 * by this point and a courtesy question must never derail what follows.
 */
export async function runDesktopUninstallFeedbackStep(
  deps: DesktopUninstallFeedbackStepDeps,
): Promise<DesktopUninstallFeedbackStepOutcome> {
  try {
    const answers = await deps.collect();
    if (!hasUninstallFeedbackContent(answers)) return { status: 'skipped' };
    const submit = deps.submit ?? postUninstallFeedback;
    const result = await submit({
      ...answers,
      source: 'desktop_uninstall',
      appVersion: deps.appVersion,
      platform: deps.platform ?? process.platform,
    });
    return { status: 'submitted', result };
  } catch (error) {
    return { status: 'failed', error };
  }
}

export interface DesktopUninstallOutcomeStepDeps {
  /** How the cleanup script finished; the failure branch carries its own error. */
  cleanup: RunDesktopUninstallCleanupResult;
  /** Asked only when cleanup succeeded, before the finish screen. */
  runFeedbackStep: () => Promise<void>;
  showCompletion: () => Promise<void>;
  /** Receives the narrowed failure so the notice can't be handed a blank error. */
  showFailure: (cleanup: { error: string }) => Promise<void>;
}

/**
 * The screens after cleanup runs. Feedback is asked only on success — right
 * after the uninstall the user came to do is done, and before the finish
 * screen — so a failed (and possibly retried) uninstall is never surveyed.
 */
export async function runDesktopUninstallOutcomeStep(
  deps: DesktopUninstallOutcomeStepDeps,
): Promise<void> {
  if (!deps.cleanup.ok) {
    await deps.showFailure(deps.cleanup);
    return;
  }
  await deps.runFeedbackStep();
  await deps.showCompletion();
}

export function defaultDesktopUninstallLogPath(
  home: string = homedir(),
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return join(home, 'Library', 'Logs', 'OpenKnowledge', `uninstall-${stamp}.log`);
}

/** Keeps the failure dialog a readable height; the full log stays on disk. */
const UNINSTALL_LOG_DISPLAY_MAX_CHARS = 4000;

/**
 * The cleanup log's tail, sized for a native message-box `detail`, or null
 * when the log is missing/unreadable/empty (the dialog then falls back to the
 * path-only hint). Tail, not head: the per-item failure lines and the
 * `deinit=…/global=…` summary land at the end.
 */
export function readDesktopUninstallLogForDisplay(
  logPath: string,
  deps: { readFile?: (path: string) => string } = {},
): string | null {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf-8'));
  try {
    const text = readFile(logPath).trim();
    if (text.length === 0) return null;
    if (text.length <= UNINSTALL_LOG_DISPLAY_MAX_CHARS) return text;
    return `… (earlier lines omitted — full log on disk)\n${text.slice(-UNINSTALL_LOG_DISPLAY_MAX_CHARS)}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Notice dialogs (styled replacements for native message boxes)
// ---------------------------------------------------------------------------

/**
 * A notice rendered in the React uninstall window rather than a native
 * `dialog.showMessageBox`, whose `detail` sits at macOS's fixed small font —
 * which is what pushed these off NSAlert.
 */
interface DesktopUninstallChecklistItem {
  label: string;
  detail?: string;
  /** `true` = already done (✓); `false` = the one remaining action (○). */
  done: boolean;
}

export interface DesktopUninstallNoticeSpec {
  title: string;
  /** One muted line under the title (e.g. "Almost done. Here's what's left."). */
  subtitle?: string;
  paragraphs: string[];
  /** A done/pending checklist rendered in the body, for the recap-plus-action screen. */
  checklist?: DesktopUninstallChecklistItem[];
  /** Small muted line under the body (e.g. the cleanup log path). */
  footnote?: string;
  /**
   * When set, renders a subtle link with this text that reveals the cleanup log
   * in Finder. The path itself never reaches the renderer — main holds it and
   * reveals on the `notice-reveal-log` intent.
   */
  logRevealLabel?: string;
  /** Monospace scrollable block (the cleanup log). */
  log?: string;
  confirmLabel: string;
  /** When present the notice is a two-button question; closing means Cancel. */
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

/** Confirmation shown when no projects were found (the picker otherwise confirms). */
export function desktopUninstallConfirmNotice(): DesktopUninstallNoticeSpec {
  return {
    title: 'Uninstall OpenKnowledge?',
    paragraphs: [
      'This removes OpenKnowledge’s settings and integrations from your Mac, but keeps your markdown content and authored skills.',
      'When cleanup finishes, OpenKnowledge will help you remove the app itself, then quit.',
    ],
    confirmLabel: 'Uninstall OpenKnowledge',
    cancelLabel: 'Cancel',
    danger: true,
  };
}

export function desktopUninstallCompletionNotice(opts: {
  projectCount: number;
}): DesktopUninstallNoticeSpec {
  const removedDetail =
    opts.projectCount > 0
      ? `Cleaned up, including from ${opts.projectCount} project${opts.projectCount === 1 ? '' : 's'}.`
      : 'Settings and integrations were cleaned up.';
  // A scannable checklist rather than prose: the two done items are glanceable
  // reassurance, and the eye lands on the one pending item — the real action.
  return {
    title: 'OpenKnowledge files were removed',
    subtitle: "Almost done. Here's what happened and what's left.",
    paragraphs: [],
    checklist: [
      {
        label: 'Kept your content',
        detail: 'Markdown files and authored skills were left untouched.',
        done: true,
      },
      { label: 'Removed OpenKnowledge files', detail: removedDetail, done: true },
      {
        label: 'Move OpenKnowledge.app to the Trash',
        detail:
          'Reveal in Finder shows the app and quits OpenKnowledge, so you can drag it to the Trash.',
        done: false,
      },
    ],
    logRevealLabel: 'Cleanup log',
    confirmLabel: 'Reveal in Finder',
  };
}

export function desktopUninstallFailureNotice(opts: {
  error: string;
  logPath: string;
  logText: string | null;
}): DesktopUninstallNoticeSpec {
  if (opts.logText === null) {
    return {
      title: 'Cleanup didn’t finish',
      paragraphs: ['Some files may not have been removed.', opts.error],
      footnote: `Cleanup log (if present): ${opts.logPath}`,
      confirmLabel: 'Continue',
    };
  }
  // With the log visible, the raw exit-code error line adds nothing.
  return {
    title: 'Cleanup didn’t finish',
    paragraphs: ['Some files may not have been removed — details below.'],
    log: opts.logText,
    footnote: `Also saved to ${opts.logPath}`,
    confirmLabel: 'Continue',
  };
}

/** Failure-path follow-up; the success notice folds this step into its checklist. */
export function desktopUninstallFinalStepNotice(): DesktopUninstallNoticeSpec {
  // Same last action as the success screen, so keep the copy + button aligned.
  return {
    title: 'One more step',
    paragraphs: [
      'Reveal in Finder shows the app and quits OpenKnowledge, so you can drag it to the Trash.',
    ],
    confirmLabel: 'Reveal in Finder',
  };
}

function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

export function buildDesktopUninstallCleanupScript(input: DesktopUninstallCleanupInput): string {
  const projectArgs = input.projectPaths.map(shellQuote).join(' ');
  const projectBlock =
    input.projectPaths.length === 0
      ? 'echo "No project deinit paths selected."\nDEINIT_EXIT=0'
      : `DEINIT_EXIT=0
set -- ${projectArgs}
for project in "$@"; do
  if [ -d "$project/.ok" ]; then
    echo "Deinitializing project: $project"
    "$OK_CLI" deinit --yes "$project"
    code=$?
    if [ "$code" -ne 0 ]; then
      echo "Project deinit failed ($code): $project"
      DEINIT_EXIT=1
    fi
  else
    echo "Skipping project without .ok: $project"
  fi
done`;

  return `#!/bin/sh
# Generated by OpenKnowledge Desktop. Intentionally no set -e: every cleanup
# stage should run, and failures are captured in LOG for manual follow-up.
OK_CLI=${shellQuote(input.cliPath)}
LOG=${shellQuote(input.logPath)}
LOG_DIR=${shellQuote(dirname(input.logPath))}
EXIT_CODE=0

mkdir -p "$LOG_DIR"
{
  echo "OpenKnowledge uninstall cleanup started at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Log: $LOG"

  GLOBAL_EXIT=0
  DEINIT_EXIT=0
  if [ -x "$OK_CLI" ]; then
${projectBlock
  .split('\n')
  .map((line) => `    ${line}`)
  .join('\n')}
    echo "Removing global OpenKnowledge footprint."
    "$OK_CLI" uninstall --yes
    GLOBAL_EXIT=$?
    if [ "$GLOBAL_EXIT" -ne 0 ]; then
      echo "Global uninstall failed with exit code $GLOBAL_EXIT."
    fi
  else
    echo "Bundled CLI missing or not executable: $OK_CLI"
    GLOBAL_EXIT=69
  fi

  if [ "$DEINIT_EXIT" -ne 0 ] || [ "$GLOBAL_EXIT" -ne 0 ]; then
    EXIT_CODE=1
  fi

  echo "OpenKnowledge uninstall cleanup finished at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "deinit=$DEINIT_EXIT global=$GLOBAL_EXIT"
} >> "$LOG" 2>&1
exit "$EXIT_CODE"
`;
}

export function runDesktopUninstallCleanup(
  input: DesktopUninstallCleanupInput,
  deps: RunDesktopUninstallCleanupDeps = {},
): Promise<RunDesktopUninstallCleanupResult> {
  const spawn = deps.spawn ?? spawnChild;
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (result: RunDesktopUninstallCleanupResult): void => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };

    try {
      const child = spawn('/bin/sh', ['-c', buildDesktopUninstallCleanupScript(input)], {
        // Never inherit a cwd inside the app bundle; keeping the bundle idle
        // lets the user move it to Trash after cleanup and app quit.
        cwd: '/',
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', (err) => finish({ ok: false, error: err.message }));
      child.once('close', (code, signal) => {
        if (code === 0) {
          finish({ ok: true });
          return;
        }
        const error =
          signal != null
            ? `cleanup process exited after signal ${signal}`
            : `cleanup process exited with code ${code ?? 'unknown'}`;
        finish({ ok: false, error, exitCode: code });
      });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

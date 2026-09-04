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

export type DesktopUninstallFlowPreviewMode = 'success' | 'failure';

type DesktopUninstallScreenPreviewMode = 'renderer' | 'picker' | 'survey' | 'notice';

export type DesktopUninstallUiPreviewMode =
  | DesktopUninstallFlowPreviewMode
  | DesktopUninstallScreenPreviewMode;

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

export function resolveAppBundleFromExecPath(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'darwin') return null;
  const match = execPath.match(APP_BUNDLE_FROM_EXEC_RE);
  return match?.[1] ?? null;
}

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

function boundedFeedbackAnswer(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  return trimmed.slice(0, maxLength);
}

export function normalizeDesktopUninstallFeedbackAnswers(raw: unknown): UninstallFeedbackAnswers {
  const record: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {};
  const note = boundedFeedbackAnswer(record.note, UNINSTALL_FEEDBACK_NOTE_MAX_LEN);
  const email = boundedFeedbackAnswer(record.email, UNINSTALL_FEEDBACK_EMAIL_MAX_LEN);
  return {
    ...(isUninstallFeedbackReason(record.reason) ? { reason: record.reason } : {}),
    ...(note === undefined ? {} : { note }),
    ...(email === undefined ? {} : { email }),
  };
}

export interface DesktopUninstallConfirmStepDeps {
  candidates: readonly DesktopUninstallProjectCandidate[];
  showProjectPicker: (
    candidates: readonly DesktopUninstallProjectCandidate[],
  ) => Promise<DesktopUninstallProjectCandidate[] | null>;
  showConfirmNotice: () => Promise<boolean>;
}

export type DesktopUninstallConfirmOutcome =
  | { proceed: false }
  | { proceed: true; projectPaths: string[] };

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

export interface DesktopUninstallFeedbackStepDeps {
  collect: () => Promise<UninstallFeedbackAnswers>;
  appVersion: string;
  platform?: string;
  submit?: (submission: UninstallFeedbackSubmission) => Promise<UninstallFeedbackResult>;
}

export type DesktopUninstallFeedbackStepOutcome =
  | { status: 'skipped' }
  | { status: 'submitted'; result: UninstallFeedbackResult }
  | { status: 'failed'; error: unknown };

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
  cleanup: RunDesktopUninstallCleanupResult;
  runFeedbackStep: () => Promise<void>;
  showCompletion: () => Promise<void>;
  showFailure: (cleanup: { error: string }) => Promise<void>;
}

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

const UNINSTALL_LOG_DISPLAY_MAX_CHARS = 4000;

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

interface DesktopUninstallChecklistItem {
  label: string;
  detail?: string;
  done: boolean;
}

export interface DesktopUninstallNoticeSpec {
  title: string;
  subtitle?: string;
  paragraphs: string[];
  checklist?: DesktopUninstallChecklistItem[];
  footnote?: string;
  logRevealLabel?: string;
  log?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

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
  return {
    title: 'Cleanup didn’t finish',
    paragraphs: ['Some files may not have been removed — details below.'],
    log: opts.logText,
    footnote: `Also saved to ${opts.logPath}`,
    confirmLabel: 'Continue',
  };
}

export function desktopUninstallFinalStepNotice(): DesktopUninstallNoticeSpec {
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

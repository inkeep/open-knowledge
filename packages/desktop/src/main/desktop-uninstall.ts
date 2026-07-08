/**
 * Desktop self-uninstall orchestration.
 *
 * The running Electron process must not delete its own `.app` bundle. Instead
 * main shows the confirmation UI, runs the bundled CLI cleanup while displaying
 * progress (`ok deinit` for explicitly selected projects, then
 * `ok uninstall --yes` for the global footprint), and finally reveals
 * OpenKnowledge.app in Finder so the user can drag it to the Trash.
 *
 * Electron-free + dependency-injected so the path predicates and generated
 * helper script are unit-testable without an Electron runtime.
 */

import { spawn as spawnChild } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

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

function desktopUninstallProjectSourceTags(candidate: DesktopUninstallProjectCandidate): string[] {
  return [
    candidate.open ? 'open' : null,
    candidate.running ? 'running' : null,
    candidate.recent ? 'recent' : null,
  ].filter((tag): tag is string => tag !== null);
}

export function formatDesktopUninstallProjectList(
  candidates: readonly DesktopUninstallProjectCandidate[],
  maxRows = 8,
): string {
  if (candidates.length === 0) return 'No recent, open, or running OpenKnowledge projects found.';

  const rows = candidates.slice(0, maxRows).map((candidate) => {
    const tags = desktopUninstallProjectSourceTags(candidate);
    return `• ${candidate.path}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`;
  });
  if (candidates.length > maxRows) {
    rows.push(`• …and ${candidates.length - maxRows} more`);
  }
  return rows.join('\n');
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return ch;
    }
  });
}

function buildDesktopUninstallProjectRows(
  candidates: readonly DesktopUninstallProjectCandidate[],
): string {
  if (candidates.length === 0) {
    return '<div class="empty-list">No recent, open, or running OpenKnowledge projects were found.</div>';
  }

  return candidates
    .map((candidate, index) => {
      const name = basename(candidate.path) || candidate.path;
      const tags = desktopUninstallProjectSourceTags(candidate)
        .map((tag) => `<span class="tag">${htmlEscape(tag)}</span>`)
        .join('');
      return `<label class="project-row">
  <input type="checkbox" data-index="${index}" aria-label="Remove OpenKnowledge from ${htmlEscape(candidate.path)}" />
  <span class="project-main">
    <span class="project-name">${htmlEscape(name)}</span>
    <span class="project-path">${htmlEscape(candidate.path)}</span>
  </span>
  <span class="project-tags" aria-label="Project sources">${tags}</span>
</label>`;
    })
    .join('\n');
}

const DESKTOP_UNINSTALL_PICKER_SCHEME = 'ok-desktop-uninstall:';

/**
 * Inline, sandbox-friendly picker HTML. Main owns the candidate paths; the page
 * returns only selected candidate indexes through a main-intercepted private
 * navigation URL, not renderer-supplied paths.
 */
export function buildDesktopUninstallProjectPickerHtml(
  candidates: readonly DesktopUninstallProjectCandidate[],
): string {
  const projectCount = candidates.length;
  const projectWord = projectCount === 1 ? 'project' : 'projects';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;"
/>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Uninstall OpenKnowledge</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: CanvasText;
    background: Canvas;
  }
  .dialog {
    display: flex;
    flex-direction: column;
    height: 100vh;
    min-height: 0;
  }
  .header {
    padding: 22px 24px 14px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
  }
  h1 {
    margin: 0 0 10px;
    font-size: 20px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  p { margin: 0 0 8px; line-height: 1.42; }
  .muted { color: color-mix(in srgb, CanvasText 68%, transparent); }
  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 14px;
  }
  .controls strong { font-weight: 600; }
  .control-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    appearance: none;
    border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
    border-radius: 7px;
    background: color-mix(in srgb, Canvas 88%, CanvasText 12%);
    color: CanvasText;
    padding: 6px 11px;
    font: inherit;
    cursor: default;
  }
  button:hover { background: color-mix(in srgb, Canvas 82%, CanvasText 18%); }
  button:focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }
  .list-region {
    flex: 1;
    min-height: 0;
    padding: 14px 24px;
  }
  .scroll-hint {
    margin: 0 0 8px;
    color: color-mix(in srgb, CanvasText 62%, transparent);
    font-size: 13px;
  }
  .project-list {
    height: calc(100% - 24px);
    min-height: 180px;
    overflow-y: scroll;
    scrollbar-gutter: stable;
    border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, Canvas 96%, CanvasText 4%);
  }
  .project-list::-webkit-scrollbar { width: 12px; height: 12px; }
  .project-list::-webkit-scrollbar-track { background: color-mix(in srgb, Canvas 88%, CanvasText 12%); border-radius: 999px; }
  .project-list::-webkit-scrollbar-thumb { background: color-mix(in srgb, CanvasText 36%, transparent); border: 3px solid transparent; border-radius: 999px; background-clip: content-box; }
  .project-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 10px;
    align-items: start;
    padding: 10px 12px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
  }
  .project-row:last-child { border-bottom: 0; }
  .project-row:hover { background: color-mix(in srgb, Highlight 12%, transparent); }
  .project-row input { margin: 2px 0 0; }
  .project-main { min-width: 0; }
  .project-name {
    display: block;
    font-weight: 600;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .project-path {
    display: block;
    margin-top: 3px;
    color: color-mix(in srgb, CanvasText 64%, transparent);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.35;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .project-tags { display: flex; justify-content: flex-end; gap: 4px; flex-wrap: wrap; max-width: 190px; }
  .tag {
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    border-radius: 999px;
    padding: 2px 6px;
    color: color-mix(in srgb, CanvasText 72%, transparent);
    background: color-mix(in srgb, Canvas 90%, CanvasText 10%);
    font-size: 12px;
    line-height: 1.2;
  }
  .empty-list { padding: 18px; color: color-mix(in srgb, CanvasText 62%, transparent); }
  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 14px 24px 18px;
    border-top: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
  }
  .selected-count { color: color-mix(in srgb, CanvasText 68%, transparent); font-size: 13px; }
  .footer-buttons { display: flex; gap: 10px; }
  .danger {
    border-color: color-mix(in srgb, #d70015 58%, CanvasText 12%);
    background: color-mix(in srgb, #d70015 82%, black 18%);
    color: white;
    font-weight: 600;
  }
  .danger:hover { background: color-mix(in srgb, #d70015 74%, black 26%); }
  @media (max-width: 640px) {
    .project-row { grid-template-columns: auto minmax(0, 1fr); }
    .project-tags { grid-column: 2; justify-content: flex-start; max-width: none; }
    .footer { align-items: stretch; flex-direction: column; }
    .footer-buttons { justify-content: flex-end; }
  }
</style>
</head>
<body>
  <main class="dialog" role="dialog" aria-labelledby="title" aria-describedby="description">
    <section class="header">
      <h1 id="title">Uninstall OpenKnowledge?</h1>
      <p id="description">This removes OpenKnowledge’s settings and integrations from your Mac. Your markdown content and authored skills are kept.</p>
      <p class="muted">Optionally select projects to also remove OpenKnowledge from. None are selected by default.</p>
      <div class="controls">
        <strong>${projectCount} detected ${projectWord}</strong>
        <div class="control-buttons" aria-label="Project selection controls">
          <button id="select-all" type="button">Select all</button>
          <button id="select-none" type="button">Select none</button>
        </div>
      </div>
    </section>
    <section class="list-region" aria-label="Detected OpenKnowledge projects">
      <p class="scroll-hint">Scrollable list — review all ${projectCount} ${projectWord} before uninstalling.</p>
      <div class="project-list" id="project-list">
${buildDesktopUninstallProjectRows(candidates)}
      </div>
    </section>
    <section class="footer">
      <div class="selected-count" id="selected-count">0 projects selected.</div>
      <div class="footer-buttons">
        <button id="cancel" type="button" autofocus>Cancel</button>
        <button id="confirm" class="danger" type="button">Uninstall OpenKnowledge</button>
      </div>
    </section>
  </main>
<script>
(() => {
  const boxes = Array.from(document.querySelectorAll('input[type="checkbox"][data-index]'));
  const selectedCount = document.getElementById('selected-count');
  const selectedIndexes = () => boxes
    .filter((box) => box.checked)
    .map((box) => Number(box.dataset.index))
    .filter((index) => Number.isInteger(index));
  const finish = (action, indexes = []) => {
    window.location.href = 'ok-desktop-uninstall://' + action + '?indexes=' + encodeURIComponent(indexes.join(','));
  };
  const update = () => {
    const count = selectedIndexes().length;
    const noun = count === 1 ? 'project' : 'projects';
    selectedCount.textContent = count + ' ' + noun + ' selected.';
  };
  const selectAll = () => { boxes.forEach((box) => { box.checked = true; }); update(); };
  const selectNone = () => { boxes.forEach((box) => { box.checked = false; }); update(); };
  const cancel = () => finish('cancel');
  boxes.forEach((box) => box.addEventListener('change', update));
  document.getElementById('select-all').addEventListener('click', selectAll);
  document.getElementById('select-none').addEventListener('click', selectNone);
  document.getElementById('cancel').addEventListener('click', cancel);
  document.getElementById('confirm').addEventListener('click', () => {
    finish('confirm', selectedIndexes());
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancel();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selectAll();
    }
  });
  update();
})();
</script>
</body>
</html>`;
}

export function parseDesktopUninstallProjectPickerUrl(url: string): unknown | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== DESKTOP_UNINSTALL_PICKER_SCHEME) return null;

  if (parsed.hostname === 'cancel') return { action: 'cancel' };
  if (parsed.hostname !== 'confirm') return null;

  const indexesRaw = parsed.searchParams.get('indexes') ?? '';
  const selectedIndexes = indexesRaw
    .split(',')
    .filter((part) => /^\d+$/.test(part))
    .map((part) => Number.parseInt(part, 10));
  return { action: 'confirm', selectedIndexes };
}

export function resolveDesktopUninstallProjectSelection(
  candidates: readonly DesktopUninstallProjectCandidate[],
  raw: unknown,
): DesktopUninstallProjectCandidate[] | null {
  if (raw == null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record.action !== 'confirm') return null;

  const rawIndexes = Array.isArray(record.selectedIndexes) ? record.selectedIndexes : [];
  const selected = new Set<number>();
  for (const value of rawIndexes) {
    if (Number.isInteger(value) && value >= 0 && value < candidates.length) {
      selected.add(value);
    }
  }
  return candidates.filter((_, index) => selected.has(index));
}

export function buildDesktopUninstallProgressHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline';"
/>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Uninstalling OpenKnowledge</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: CanvasText;
    background: Canvas;
  }
  .wrap { text-align: center; padding: 28px; max-width: 360px; }
  .spinner {
    width: 34px;
    height: 34px;
    margin: 0 auto 18px;
    border: 3px solid color-mix(in srgb, CanvasText 18%, transparent);
    border-top-color: Highlight;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  h1 { margin: 0 0 8px; font-size: 18px; font-weight: 650; }
  p { margin: 0; line-height: 1.42; color: color-mix(in srgb, CanvasText 68%, transparent); }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <main class="wrap" role="status" aria-live="polite">
    <div class="spinner" aria-hidden="true"></div>
    <h1>Removing OpenKnowledge files…</h1>
    <p>This may take a moment. Your markdown content is kept.</p>
  </main>
</body>
</html>`;
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
 * A simple message dialog rendered as an inline HTML window. Native
 * `dialog.showMessageBox` renders `detail` at macOS's fixed small font, which
 * is what pushed these off NSAlert.
 */
export interface DesktopUninstallNoticeSpec {
  title: string;
  paragraphs: string[];
  /** Small muted line under the body (e.g. the cleanup log path). */
  footnote?: string;
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
      'This removes OpenKnowledge’s settings and integrations from your Mac. Your markdown content and authored skills are kept.',
      'When cleanup finishes, OpenKnowledge will help you remove the app itself, then quit.',
    ],
    confirmLabel: 'Uninstall OpenKnowledge',
    cancelLabel: 'Cancel',
    danger: true,
  };
}

export function desktopUninstallCompletionNotice(opts: {
  projectCount: number;
  logPath: string;
}): DesktopUninstallNoticeSpec {
  const paragraphs = ['Your markdown content and authored skills were kept.'];
  if (opts.projectCount > 0) {
    paragraphs.push(
      `OpenKnowledge was also removed from ${opts.projectCount} project${opts.projectCount === 1 ? '' : 's'}.`,
    );
  }
  paragraphs.push(
    'One step left: move OpenKnowledge.app to the Trash.',
    'Click Continue to show the app in Finder. OpenKnowledge will then quit.',
  );
  return {
    title: 'OpenKnowledge files were removed',
    paragraphs,
    footnote: `Cleanup log: ${opts.logPath}`,
    confirmLabel: 'Continue',
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

/** Failure-path follow-up; the success notice folds this step in. */
export function desktopUninstallFinalStepNotice(): DesktopUninstallNoticeSpec {
  return {
    title: 'One more step',
    paragraphs: [
      'Move OpenKnowledge.app to the Trash to finish.',
      'Click Continue to show the app in Finder. OpenKnowledge will then quit.',
    ],
    confirmLabel: 'Continue',
  };
}

export function parseDesktopUninstallNoticeUrl(url: string): 'confirm' | 'cancel' | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== DESKTOP_UNINSTALL_PICKER_SCHEME) return null;
  if (parsed.hostname === 'notice-confirm') return 'confirm';
  if (parsed.hostname === 'notice-cancel') return 'cancel';
  return null;
}

export function buildDesktopUninstallNoticeHtml(spec: DesktopUninstallNoticeSpec): string {
  const paragraphs = spec.paragraphs.map((text) => `<p>${htmlEscape(text)}</p>`).join('\n');
  const logBlock = spec.log === undefined ? '' : `<pre class="log">${htmlEscape(spec.log)}</pre>`;
  const footnote =
    spec.footnote === undefined ? '' : `<p class="footnote">${htmlEscape(spec.footnote)}</p>`;
  const cancelButton =
    spec.cancelLabel === undefined
      ? ''
      : `<button id="cancel" type="button" autofocus>${htmlEscape(spec.cancelLabel)}</button>`;
  // Two-button notices keep focus on Cancel (destructive-safe default, matching
  // NSAlert's cancel-default convention); single-button notices focus Continue.
  const confirmAutofocus = spec.cancelLabel === undefined ? ' autofocus' : '';
  const confirmClass = spec.danger ? 'danger' : 'primary';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';"
/>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${htmlEscape(spec.title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: CanvasText;
    background: Canvas;
  }
  .dialog {
    display: flex;
    flex-direction: column;
    height: 100vh;
    min-height: 0;
    padding: 22px 24px 18px;
  }
  h1 {
    margin: 0 0 12px;
    font-size: 20px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  p { margin: 0 0 10px; line-height: 1.45; }
  .log {
    flex: 1;
    min-height: 80px;
    margin: 2px 0 10px;
    padding: 10px 12px;
    overflow: auto;
    border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, Canvas 96%, CanvasText 4%);
    font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .footnote {
    margin: 0;
    color: color-mix(in srgb, CanvasText 62%, transparent);
    font-size: 12.5px;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .buttons { display: flex; justify-content: flex-end; gap: 10px; padding-top: 14px; }
  button {
    appearance: none;
    border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
    border-radius: 7px;
    background: color-mix(in srgb, Canvas 88%, CanvasText 12%);
    color: CanvasText;
    padding: 7px 14px;
    font: inherit;
    cursor: default;
  }
  button:hover { background: color-mix(in srgb, Canvas 82%, CanvasText 18%); }
  button:focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }
  /* Chromium's Highlight keyword is the pale selection blue — too light for a
     filled button — so the primary uses the concrete macOS system blues. */
  .primary {
    border-color: transparent;
    background: #007aff;
    color: white;
    font-weight: 600;
  }
  .primary:hover { background: color-mix(in srgb, #007aff 86%, black 14%); }
  @media (prefers-color-scheme: dark) {
    .primary { background: #0a84ff; }
    .primary:hover { background: color-mix(in srgb, #0a84ff 86%, black 14%); }
  }
  .danger {
    border-color: color-mix(in srgb, #d70015 58%, CanvasText 12%);
    background: color-mix(in srgb, #d70015 82%, black 18%);
    color: white;
    font-weight: 600;
  }
  .danger:hover { background: color-mix(in srgb, #d70015 74%, black 26%); }
</style>
</head>
<body>
  <main class="dialog" role="alertdialog" aria-labelledby="title" aria-describedby="body">
    <h1 id="title">${htmlEscape(spec.title)}</h1>
    <div class="body" id="body">
${paragraphs}
${logBlock}
${footnote}
    </div>
    <div class="buttons">
      ${cancelButton}
      <button id="confirm" class="${confirmClass}" type="button"${confirmAutofocus}>${htmlEscape(spec.confirmLabel)}</button>
    </div>
  </main>
<script>
(() => {
  const hasCancel = ${spec.cancelLabel === undefined ? 'false' : 'true'};
  const finish = (action) => {
    window.location.href = 'ok-desktop-uninstall://notice-' + action;
  };
  document.getElementById('confirm').addEventListener('click', () => finish('confirm'));
  if (hasCancel) {
    document.getElementById('cancel').addEventListener('click', () => finish('cancel'));
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') finish(hasCancel ? 'cancel' : 'confirm');
  });
})();
</script>
</body>
</html>`;
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

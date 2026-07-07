/**
 * First-launch MCP wiring — pure helpers.
 *
 * Marker read/write at `<home>/.ok/mcp-status.json`, dependency-injected for
 * bun-test loadability. The user-scoped marker fires the consent dialog exactly
 * once per user per Mac. Shape is either `{configured: true, configuredAt,
 * editors}` on Add, or `{configured: false, skippedAt}` on Skip. `null` return
 * means "no prior decision" — run the consent flow.
 *
 * Editor-entry overwrite policy: the desktop owns the `open-knowledge` MCP
 * server namespace once that token exists. First-launch confirm rewrites every
 * selected existing entry under that name, and startup repair scans all supported
 * editors on every packaged boot, rewriting incompatible existing entries to the
 * current resilient chain shape. Missing entries remain no-create no-ops.
 *
 * The same first-launch dialog also gates the shell-PATH rc-append: the show
 * payload carries a `pathInstall` descriptor, the confirm request carries the
 * PATH toggle, and the confirm handler finalizes the decision through the
 * injected `McpWiringPathInstallSurface` (backed by `path-install.ts`). PATH
 * is the one place the desktop CREATES footprint in files it does not own
 * (`~/.zshrc` and friends) — hence explicit consent, unlike the
 * rewrite-if-exists reclaim posture above.
 *
 * Pure layer uses `electron`-free imports
 * + an injectable `FsOps` so bun-test can load the module without an
 * Electron runtime; runtime functions that need `dialog` / `app.getPath`
 * land separately with dynamic `await import('electron')`.
 */

import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  readFileSync as fsReadFileSync,
  renameSync as fsRenameSync,
  unlinkSync as fsUnlinkSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildMcpConfigDeclineEvent,
  buildMcpConfigMigrateEvent,
  type EditorMcpTarget,
  isEntryUpToDate,
  type McpDeclineReason,
  type McpEntryClassification,
} from '@inkeep/open-knowledge';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type {
  McpWiringConfirmRequest,
  McpWiringConfirmResult,
  McpWiringEditorDetection,
  McpWiringEditorId,
  McpWiringPathInstallDescriptor,
  McpWiringSkipResult,
} from '../shared/ipc-channels.ts';
import { createHandler } from '../shared/ipc-handler.ts';
import { type SendableWebContents, sendToRenderer } from '../shared/ipc-send.ts';
import { logIpcError } from './ipc-log.ts';

const MCP_STATUS_DIR_NAME = '.ok';
const MCP_STATUS_FILE_NAME = 'mcp-status.json';

/**
 * Shape of `<home>/.ok/mcp-status.json`. Either a confirmed
 * wiring (`configured: true`) or a recorded skip (`configured: false`).
 * Absence of the file means "no prior decision" — distinct from a
 * persisted skip, which suppresses the dialog forever.
 */
export type McpStatusMarker =
  | {
      configured: true;
      configuredAt: string;
      editors: string[];
    }
  | {
      configured: false;
      skippedAt: string;
    };

/**
 * Minimal `fs` surface the pure helpers need. Runtime wraps `node:fs`;
 * tests inject a stub. Kept narrow so test stubs stay compact.
 *
 * `renameSync` + `unlinkSync` are added for the atomic marker write
 * pattern (mirrors `state-store.saveAppStateToDir`): write to a
 * `.tmp-<pid>-<ts>` sibling, then `rename` over the canonical path so a
 * power-loss between write and fsync can't leave a truncated marker on
 * disk.
 */
export interface McpWiringFsOps {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, content: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
}

/** Runtime FsOps — thin wrapper over `node:fs`. */
const defaultFsOps: McpWiringFsOps = {
  existsSync: (path) => fsExistsSync(path),
  readFileSync: (path, encoding) => fsReadFileSync(path, encoding),
  writeFileSync: (path, content) => {
    fsWriteFileSync(path, content);
  },
  mkdirSync: (path, options) => {
    fsMkdirSync(path, options);
  },
  renameSync: (oldPath, newPath) => {
    fsRenameSync(oldPath, newPath);
  },
  unlinkSync: (path) => {
    fsUnlinkSync(path);
  },
};

/** Absolute path of the user-scoped marker file under `home`. */
function mcpStatusMarkerPath(home: string): string {
  return join(home, MCP_STATUS_DIR_NAME, MCP_STATUS_FILE_NAME);
}

/**
 * Read the marker if present. Returns `null` when the file is absent,
 * unreadable, or not valid JSON matching either marker shape — either
 * case means "no prior decision recorded, run the consent flow".
 *
 * Tolerant on purpose: a corrupt marker must not permanently lock a user
 * out of the consent prompt. A subsequent successful write via
 * `writeMcpStatusMarker` will replace the corrupted file.
 */
export function readMcpStatusMarker(
  home: string,
  fs: McpWiringFsOps = defaultFsOps,
): McpStatusMarker | null {
  const path = mcpStatusMarkerPath(home);
  if (!fs.existsSync(path)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isValidMarker(parsed) ? parsed : null;
}

function isValidMarker(value: unknown): value is McpStatusMarker {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.configured === true) {
    return (
      typeof v.configuredAt === 'string' &&
      Array.isArray(v.editors) &&
      v.editors.every((e) => typeof e === 'string')
    );
  }
  if (v.configured === false) {
    return typeof v.skippedAt === 'string';
  }
  return false;
}

/**
 * Write the marker atomically. Creates `<home>/.ok/` when absent
 * so the first-ever first-launch write succeeds on a machine with no prior
 * OK user-level state. Pretty-printed + trailing newline so `cat` output is
 * readable for a user inspecting their own config.
 *
 * Atomic write via tmp+rename. Mirrors `state-store.saveAppStateToDir`:
 * write to a `<path>.tmp-<pid>-<now>` sibling, then `rename` over the
 * canonical path. A power-loss between `writeFileSync` and `rename` leaves
 * the canonical marker untouched (or absent) and a stray `.tmp-…`
 * sibling — both safer failure modes than a truncated marker.
 * `readMcpStatusMarker` already tolerates the truncated-marker case
 * (returns `null`, dialog re-fires) so atomicity is defense-in-depth, not
 * a correctness requirement; consistency with the rest of the desktop
 * main process is the primary win.
 */
export function writeMcpStatusMarker(
  home: string,
  status: McpStatusMarker,
  fs: McpWiringFsOps = defaultFsOps,
): void {
  const path = mcpStatusMarkerPath(home);
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(status, null, 2)}\n`);
  try {
    fs.renameSync(tmpPath, path);
  } catch (err) {
    // Best-effort tmp cleanup — if the rename failed, leave no stray .tmp.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // tmp file may not exist — the rename may have partially succeeded.
    }
    throw err;
  }
}

/**
 * Format the user-facing partial-failure message rendered via sonner toast.
 * Lists each failed editor + its underlying error reason, then notes the
 * deferred-marker recovery path so the user knows what to expect on next
 * launch.
 *
 * Pure helper — exported for direct unit testing without standing up the
 * full IPC handler.
 */
function formatPartialFailureMessage(
  failures: ReadonlyArray<{ editorId: string; error?: string }>,
  totalCount: number,
): string {
  const okCount = totalCount - failures.length;
  const detail = failures.map((f) => `${f.editorId}${f.error ? `: ${f.error}` : ''}`).join('; ');
  const summary =
    failures.length === 1
      ? `Couldn't add MCP to ${detail}.`
      : `${failures.length} of ${totalCount} MCP writes failed (${detail}).`;
  const successHint = okCount > 0 ? ` ${okCount} succeeded.` : '';
  return `${summary}${successHint} The dialog will reappear on next launch so you can retry.`;
}

// ---------------------------------------------------------------------------
// Runtime orchestration — runMcpWiringOnFirstLaunch
// ---------------------------------------------------------------------------

/**
 * Sender-binding predicate. Returns true iff the invoking `WebContents.id`
 * matches the captured show-dispatch sender, OR if no dispatch has
 * captured a sender yet (binding is null during the inert-handle /
 * pre-dispatch window but both handlers self-guard via `handled` so this
 * branch is unreachable in practice).
 *
 * Pure helper so unit tests can assert the binding logic without
 * threading a closure-scoped variable through the test harness.
 */
function isPermittedSender(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  capturedSenderId: number | null,
): boolean {
  // Null binding means no dispatch has succeeded yet — refuse all
  // confirms/skips so a fast renderer can't call confirm/skip before
  // the show event has been delivered anywhere.
  if (capturedSenderId === null) return false;
  return event.sender.id === capturedSenderId;
}

/**
 * Structurally-compatible subset of Electron's `IpcMain`. Declared inline
 * so tests can inject a stub without pulling in the real Electron runtime.
 * Only `handle` + `removeHandler` are needed now that `renderer-ready` is
 * modeled as an invoke-style channel — no `ipcMain.on` outside the
 * allowlisted wrappers.
 */
interface IpcMainLike extends Pick<IpcMain, 'handle' | 'removeHandler'> {}

/**
 * WebContents shape for the mid-session immediate dispatch — sendable plus
 * the `id` that confirm/skip sender-binding validates against. Real
 * Electron `WebContents` satisfies it; tests inject a fake.
 */
export interface McpWiringDispatchTarget extends SendableWebContents {
  readonly id: number;
}

/**
 * Shape consumed from the CLI side (`@inkeep/open-knowledge`). Injected so
 * tests can stub without spinning up a real CLI, and main/index.ts can
 * hand the real functions in at boot time. Member-set intentionally minimal:
 * every helper we need to classify + write per-editor configs.
 */
export interface McpWiringCliSurface {
  /** Mirrors `detectInstalledEditors(cwd, home)` from init.ts. */
  detectInstalledEditors(cwd: string, home?: string): McpWiringEditorId[];
  /** Mirrors `writeUserMcpConfigs(opts)` from init.ts. */
  writeUserMcpConfigs(opts: { editors: McpWiringEditorId[]; home?: string }): Promise<
    Array<{
      editorId: McpWiringEditorId;
      label: string;
      // The CLI always-overwrites, so `skipped-existing` / `skipped-conflict`
      // are gone. `skipped-missing` is new; `skipAvailabilityCheck: true` in
      // `writeUserMcpConfigs` means first-launch shouldn't actually produce
      // it in practice (user explicitly toggled the checkbox). `declined` is
      // the guest-ownership outcome when the write path meets a present config
      // it cannot safely edit (unparseable / oversized / duplicate container) —
      // rare here since the sweep pre-classifies, but reachable under a
      // read-then-write race. Listed so the type matches `EditorMcpResult`.
      action:
        | 'written'
        | 'overwritten'
        | 'skipped-missing'
        | 'skipped-flag'
        | 'failed'
        | 'declined';
      configPath: string;
      serverName: string;
      error?: string;
      /** Bounded reason on a `declined` action — threaded into the decline event. */
      declineReason?: McpDeclineReason;
    }>
  >;
  /** Look up an editor's existing MCP entry (format-aware). `null` when the
   *  config file is absent or has no entry for this editor. The editorId
   *  surface avoids a cross-package `EditorMcpTarget` type in this module. */
  readExistingMcpEntry(editorId: McpWiringEditorId, home: string): Record<string, unknown> | null;
  /** Discriminated classification — distinguishes 'decline' (file present but
   *  unparseable) from 'no-entry' (file parses, no entry under our server
   *  name), 'absent' (missing or blank), and 'present'. Drives the startup
   *  reclaim disposition per editor. */
  classifyExistingMcpEntry(editorId: McpWiringEditorId, home: string): McpEntryClassification;
  /** Full `ALL_EDITOR_IDS` — used to build the dialog-payload detection list. */
  allEditorIds: readonly McpWiringEditorId[];
  /** `EDITOR_TARGETS[id]` keyed by editor. Imported directly from
   *  `@inkeep/open-knowledge` so drift with the CLI's authoritative
   *  `EditorMcpTarget` shape is a compile error, not a runtime surprise. */
  editorTargets: Record<McpWiringEditorId, EditorMcpTarget>;
}

/**
 * PATH-install surface consumed by the first-launch consent flow. Injected
 * (like `McpWiringCliSurface`) so this module stays electron-free and tests
 * stub it; `main/index.ts` wires the real `path-install.ts` functions in.
 */
export interface McpWiringPathInstallSurface {
  /** Arming-time descriptor for the dialog's PATH row. Read-only — must not
   *  write. Failures are tolerated (row degrades to hidden). */
  computeDescriptor(): McpWiringPathInstallDescriptor;
  /**
   * Finalize the user's PATH decision from the consent dialog. `granted`
   * appends the managed rc block (idempotent — a present block is
   * refreshed, an opted-out file is never rewritten) and records the
   * consent on the path-install marker; `declined` records the decision
   * without touching any rc file.
   */
  applyConsent(
    status: 'granted' | 'declined',
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

/**
 * User-global skills surface consumed by the first-launch consent flow.
 * Injected (like `McpWiringPathInstallSurface`) so this module stays
 * electron-free and tests stub it; `main/index.ts` wires the real reclaim +
 * teardown pipeline in.
 */
export interface McpWiringSkillsSurface {
  /** One row per user-global bundle for the dialog. Read-only — must not
   *  write. `alreadyInstalled` pre-checks the row (grandfathered install). */
  computeDescriptors(): Array<{
    id: string;
    name: string;
    alreadyInstalled: boolean;
  }>;
  /**
   * Finalize the per-bundle decision. Records enabled for every id in
   * `enabledBundleIds` and declined for the rest, then installs the enabled
   * set and tears down any declined-but-present bundle.
   */
  applyConsent(
    enabledBundleIds: readonly string[],
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

/** Minimal logger surface — bracket-prefix operational + structured events. */
interface McpWiringLogger {
  info(msg: string, ctx?: object): void;
  warn(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
  /** Structured JSON event — tests assert on this. */
  event(payload: { event: string; [k: string]: unknown }): void;
}

const DEFAULT_LOGGER: McpWiringLogger = {
  info: (msg, ctx) => console.info('[mcp-wiring]', msg, ctx ?? ''),
  warn: (msg, ctx) => console.warn('[mcp-wiring]', msg, ctx ?? ''),
  error: (msg, ctx) => console.error('[mcp-wiring]', msg, ctx ?? ''),
  event: (payload) => console.warn(JSON.stringify(payload)),
};

interface RunMcpWiringOpts {
  /** `app.isPackaged` — dev-mode contamination guard. */
  isPackaged: boolean;
  /** `app.getPath('exe')` — must end in `.app/Contents/MacOS/<name>`. */
  executablePath: string;
  /** `os.homedir()` in production; an isolated tmpdir under Playwright smoke. */
  home: string;
  /** `process.platform` — this flow is macOS-only today. */
  platform: 'darwin' | 'win32' | 'linux' | string;
  ipcMain: IpcMainLike;
  cli: McpWiringCliSurface;
  /** Value of `process.env.OK_M6B_FORCE` — `'1'` bypasses the packaged gate for dev smokes. */
  forceEnv?: string | null | undefined;
  /** Value of `process.env.OK_RECLAIM_DISABLE` — `'1'` disables all desktop reclaim paths. */
  reclaimDisableEnv?: string | null | undefined;
  /**
   * Ignore a pre-existing marker and re-arm the dialog. Wired to the File
   * menu's "Set up OpenKnowledge integrations…" item so a user who has
   * Skip'd (or declined the PATH toggle, or wants to add an editor that
   * wasn't installed at consent time) can re-trigger from the GUI instead
   * of hand-deleting `~/.ok/mcp-status.json`.
   *
   * The other guards stay active even under forceShow: non-darwin still
   * no-ops, dev-mode still no-ops without OK_M6B_FORCE (contamination
   * guard), bad executablePath shape still aborts. Only the
   * marker-present gate is bypassed.
   */
  forceShow?: boolean;
  /**
   * Already-loaded renderer to receive `ok:mcp-wiring:show` immediately.
   * The mount-ack handshake only fires once per page load (the renderer
   * invokes `renderer-ready` at module-init), so a mid-session re-trigger
   * from the File menu would otherwise arm silently and the dialog would
   * not appear until the NEXT window load. A loaded window already has its
   * `McpConsentDialog` subscriber mounted, so dispatching directly is safe.
   * If the dispatch fails (or no target is supplied — e.g. zero open
   * windows), the mount-ack path stays armed as the fallback and the
   * dialog appears in the next renderer that signals ready.
   */
  immediateDispatchTarget?: McpWiringDispatchTarget;
  fs?: McpWiringFsOps;
  now?: () => Date;
  logger?: McpWiringLogger;
}

/**
 * First-launch consent needs the PATH-install surface on top of the shared
 * wiring opts — required here (the dialog's show payload always carries a
 * PATH descriptor) but absent from `RunMcpWiringOpts` so the startup repair
 * sweep, which never touches PATH, doesn't have to carry a dead dependency.
 */
export interface RunMcpWiringFirstLaunchOpts extends RunMcpWiringOpts {
  pathInstall: McpWiringPathInstallSurface;
  skills: McpWiringSkillsSurface;
}

export interface RunMcpWiringHandle {
  /** Tear down IPC handlers + event listener. Safe to call multiple times. */
  destroy(): void;
  /** Test-only introspection: true if the module has armed its IPC surface. */
  readonly armed: boolean;
}

export type McpStartupRepairResult =
  | { status: 'skipped'; reason: string }
  | { status: 'ok'; checkedEditors: McpWiringEditorId[] }
  | { status: 'repaired'; repairedEditors: McpWiringEditorId[] }
  | { status: 'failed'; failedEditors: Array<{ editor: McpWiringEditorId; error?: string }> };

export function checkAndRepairMcpWiringOnStartup(
  opts: RunMcpWiringOpts,
): Promise<McpStartupRepairResult> {
  const {
    isPackaged,
    executablePath,
    home,
    platform,
    cli,
    forceEnv,
    reclaimDisableEnv,
    logger = DEFAULT_LOGGER,
  } = opts;
  if (reclaimDisableEnv === '1')
    return Promise.resolve({ status: 'skipped', reason: 'reclaim-disabled' });
  if (platform !== 'darwin') return Promise.resolve({ status: 'skipped', reason: 'platform' });
  if (!isPackaged && forceEnv !== '1')
    return Promise.resolve({ status: 'skipped', reason: 'dev-mode' });
  if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath)) {
    return Promise.resolve({ status: 'skipped', reason: 'bad-executable-path' });
  }
  const selectedEditors = [...cli.allEditorIds];
  logger.event({ event: 'mcp-wiring-repair-check-started', editors: selectedEditors });
  if (selectedEditors.length === 0) return Promise.resolve({ status: 'ok', checkedEditors: [] });

  const editorsToRepair: McpWiringEditorId[] = [];
  for (const editor of selectedEditors) {
    let classification: McpEntryClassification;
    try {
      classification = cli.classifyExistingMcpEntry(editor, home);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.event({ event: 'mcp-wiring-repair-read-failed', editor, error: message });
      editorsToRepair.push(editor);
      continue;
    }

    if (classification.kind === 'absent' || classification.kind === 'no-entry') {
      // 'absent' = no file. 'no-entry' = file parses, no entry under our
      // server name (could be an unrelated tool — namespace ownership says
      // don't author into it).
      logger.event({ event: 'mcp-wiring-repair-no-token', editor });
      continue;
    }

    if (classification.kind === 'present' && isEntryUpToDate(classification.entry)) {
      logger.event({ event: 'mcp-wiring-repair-healthy-current', editor });
      continue;
    }

    if (classification.kind === 'decline') {
      // OpenKnowledge is a guest in another tool's config: a present, non-empty
      // file it cannot fully parse is left byte-untouched — never renamed aside
      // or overwritten — and registration is skipped. The bounded decline
      // signal is the only operator-facing trace; the user sees OK's server
      // simply absent rather than their config reset.
      logger.event(
        buildMcpConfigDeclineEvent({
          scope: 'user',
          surface: 'desktop-startup',
          editorId: editor,
          reason: classification.reason,
        }),
      );
      continue;
    }

    if (classification.kind === 'present') {
      // present with an incompatible entry. Emit the structured
      // `mcp-config-migrate` event before the rewrite — operators can spot stale
      // chain shapes in aggregate. `scope: 'user'` distinguishes from the
      // project-scope sweep that fires on project-open. The configPath resolver
      // may throw on a platform-mismatched target (e.g. Claude Desktop on Linux);
      // fall back to an empty string so the event still emits with the rest of
      // the fields intact.
      let migrateConfigPath = '';
      try {
        migrateConfigPath = cli.editorTargets[editor]?.configPath('', home) ?? '';
      } catch {
        // best-effort — empty string is acceptable for the event payload.
      }
      logger.event(
        buildMcpConfigMigrateEvent({
          scope: 'user',
          surface: 'desktop-startup',
          editorId: editor,
          configPath: migrateConfigPath,
          priorEntry: classification.entry,
        }),
      );
      editorsToRepair.push(editor);
      continue;
    }

    // Exhaustiveness guard: every classification kind is dispositioned above. A
    // new McpEntryClassification variant becomes a compile error here rather than
    // silently falling through to a repair write.
    const _exhaustive: never = classification;
    return _exhaustive;
  }

  if (editorsToRepair.length === 0) {
    return Promise.resolve({ status: 'ok', checkedEditors: selectedEditors });
  }

  return cli
    .writeUserMcpConfigs({ editors: editorsToRepair, home })
    .then((results) => {
      const failed = results
        .filter((r) => r.action === 'failed')
        .map((r) => ({ editor: r.editorId, error: r.error }));
      for (const r of results) {
        if (r.action === 'declined') {
          // A declined write left the config untouched (a read-then-write race
          // surfaced one the write path won't edit). Route through the shared
          // builder so the bounded reason and field shape match the classify-
          // time decline and the project-open sweep; logging it as repaired
          // would overstate what happened.
          logger.event(
            buildMcpConfigDeclineEvent({
              scope: 'user',
              surface: 'desktop-startup',
              editorId: r.editorId,
              reason: r.declineReason ?? 'unparseable',
            }),
          );
          continue;
        }
        logger.event({
          event:
            r.action === 'failed' ? 'mcp-wiring-repair-write-failed' : 'mcp-wiring-repair-repaired',
          editor: r.editorId,
          configPath: r.configPath,
          error: r.error ?? null,
        });
      }
      const repairedEditors = results
        .filter((r) => r.action === 'written' || r.action === 'overwritten')
        .map((r) => r.editorId);
      if (failed.length > 0)
        return { status: 'failed', failedEditors: failed } satisfies McpStartupRepairResult;
      // A write that declined left the config byte-unchanged (a read-then-write
      // race the sweep didn't pre-classify) — it is not a repair. Excluding it
      // keeps the `repaired` toast + repairedEditors honest; if nothing was
      // actually written, report `ok` so no "repaired" toast fires.
      if (repairedEditors.length === 0)
        return { status: 'ok', checkedEditors: selectedEditors } satisfies McpStartupRepairResult;
      return {
        status: 'repaired',
        repairedEditors,
      } satisfies McpStartupRepairResult;
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.event({
        event: 'mcp-wiring-repair-write-failed',
        editors: editorsToRepair,
        error: message,
      });
      return {
        status: 'failed',
        failedEditors: editorsToRepair.map((editor) => ({ editor, error: message })),
      } satisfies McpStartupRepairResult;
    });
}

/** Entry-point invoked from `app.whenReady()` in main/index.ts. */
export function runMcpWiringOnFirstLaunch(opts: RunMcpWiringFirstLaunchOpts): RunMcpWiringHandle {
  const {
    isPackaged,
    executablePath,
    home,
    platform,
    ipcMain,
    cli,
    pathInstall,
    skills,
    forceEnv,
    reclaimDisableEnv,
    forceShow = false,
    immediateDispatchTarget,
    fs,
    now,
    logger = DEFAULT_LOGGER,
  } = opts;
  const nowDate = (): Date => (now ? now() : new Date());
  const inertHandle: RunMcpWiringHandle = { destroy() {}, armed: false };

  if (reclaimDisableEnv === '1') {
    logger.info('skip — OK_RECLAIM_DISABLE is set');
    return inertHandle;
  }

  // macOS-only today. Windows / Linux parity deferred.
  if (platform !== 'darwin') {
    logger.info('skip — platform is not darwin', { platform });
    return inertHandle;
  }

  // Dev-mode contamination guard. In `electron-vite dev`,
  // `app.getPath('exe')` points at the dev Electron binary and `extraResources`
  // are not mounted. `OK_M6B_FORCE=1` is an explicit opt-in for developer
  // testing with an isolated HOME.
  if (!isPackaged && forceEnv !== '1') {
    logger.info('skip — app not packaged and OK_M6B_FORCE not set');
    return inertHandle;
  }

  // If executablePath doesn't match `.app/Contents/MacOS/<name>`, this is a
  // dev environment. Abort rather than contaminating real user MCP configs.
  if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath)) {
    logger.warn('skip — executablePath does not match .app/Contents/MacOS/<name> shape', {
      executablePath,
    });
    return inertHandle;
  }

  // Idempotent — marker present means prior decision recorded; never
  // re-fire UNLESS the caller asked for forceShow (the "Set up
  // OpenKnowledge integrations…" File-menu path). On forceShow we
  // log-and-continue; on first-launch-only (default) the prior decision
  // is respected as a one-way gate.
  const marker = readMcpStatusMarker(home, fs);
  if (marker !== null && !forceShow) {
    logger.info('skip — marker present', { configured: marker.configured });
    return inertHandle;
  }
  if (marker !== null && forceShow) {
    logger.info('forceShow — ignoring prior marker', { configured: marker.configured });
  }

  // Detection + payload construction under try/catch. A drift between
  // `cli.allEditorIds` and `cli.editorTargets` (CLI refactor that adds
  // an id without the matching target, or a future platform-conditional
  // getter that throws) must NOT crash `app.whenReady()` and leave the
  // user with a failing boot. Treat any detection error as "wiring inert
  // for this boot" — marker stays absent → dialog re-fires next launch
  // after the CLI is fixed. Emits a structured event so ops can correlate
  // "dialog never appeared" reports to the drift that caused it.
  let detections: McpWiringEditorDetection[];
  try {
    const detectedIds = new Set<McpWiringEditorId>(cli.detectInstalledEditors('', home));
    detections = cli.allEditorIds.map((id) => {
      const target = cli.editorTargets[id];
      if (!target) {
        throw new Error(`editorTargets missing entry for id=${id}`);
      }
      // Compute `willReplace` at arming time — the dialog surfaces "Will
      // replace" for any editor with an existing `open-knowledge` entry.
      // Namespace ownership means we ALWAYS overwrite that token under the
      // user's consent, regardless of whether the existing entry matches
      // today's chain shape or a foreign customization. The sentinel-based
      // `isEntryUpToDate` predicate is the authoritative no-op gate at
      // write time (skips byte-identical chain entries); the arming-time
      // probe here is purely a disclosure aid that errs on the side of
      // showing the user every row Add would touch. `readExistingMcpEntry`
      // returns null when the config file is absent or has no entry for
      // this editor — those rows render as "Not yet configured".
      let willReplace = false;
      try {
        const existing = cli.readExistingMcpEntry(id, home);
        if (existing !== null) {
          willReplace = true;
        }
      } catch (err) {
        // Tolerant on purpose: a read failure in one editor's config
        // must not pull the whole dialog down. Default to `false` —
        // the confirm-time classification is the authoritative source;
        // this arming-time probe is purely a disclosure aid. Info-level
        // log so operators have a breadcrumb when debugging "why did the
        // dialog not show Will Replace for <editor> when I know I have
        // an entry" — the recovery behavior is unchanged.
        logger.info('willReplace probe failed for editor', {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return { id, label: target.label, detected: detectedIds.has(id), willReplace };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('detection failed — wiring inert for this boot', { message });
    logger.event({ event: 'mcp-wiring-detect-failed', error: message });
    return inertHandle;
  }

  // PATH-row descriptor for the show payload. A descriptor failure must not
  // take the MCP consent dialog down with it — degrade to a hidden PATH row
  // (`shellDetected: false` → no decision solicited, path-install marker
  // untouched) and leave a breadcrumb. The File-menu re-trigger recovers the
  // PATH leg once the underlying cause is fixed.
  let pathDescriptor: McpWiringPathInstallDescriptor;
  try {
    pathDescriptor = pathInstall.computeDescriptor();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('path-install descriptor failed — PATH row hidden for this boot', { message });
    logger.event({ event: 'mcp-wiring-path-descriptor-failed', error: message });
    pathDescriptor = { shellDetected: false, rcFilesToTouch: [], alreadyInstalled: false };
  }

  // Skill rows for the show payload. A descriptor failure degrades to no skill
  // rows (empty ⇒ no skill decision solicited) rather than taking the dialog
  // down — the File-menu re-trigger recovers once the cause is fixed.
  let skillDescriptors: ReturnType<McpWiringSkillsSurface['computeDescriptors']>;
  try {
    skillDescriptors = skills.computeDescriptors();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('skill descriptors failed — skill rows hidden for this boot', { message });
    logger.event({ event: 'mcp-wiring-skill-descriptors-failed', error: message });
    skillDescriptors = [];
  }

  // Once-per-boot idempotence for SUCCESSFUL handler runs. Flipped
  // synchronously at handler entry on first confirm/skip so a rage-click
  // race (Add+Skip in quick succession) collapses to at most one effective
  // run. Reset to false on failure branches so the user can retry the
  // SAME dialog without waiting for a next-boot re-fire — the store
  // keeps the dialog mounted on `ok:false` results, so the user clicks
  // Add again and the retry flows through. Set and left true on ok:true
  // to prevent double-write on success-then-rage-click.
  let handled = false;

  // Bind confirm/skip acceptance to the WebContents that actually
  // received `ok:mcp-wiring:show`. Captured inside the one-shot
  // renderer-ready handler after a successful dispatch. Before capture
  // (happy-path cold boot) the binding is null — confirm/skip from any
  // renderer is rejected. After capture, only the same sender id is
  // accepted. This closes the window where any future BrowserWindow
  // with bridge access (update-toast relaunch, a second-instance spawn
  // that hasn't received the show event) could pre-empt the user's
  // choice by calling `mcpWiring.confirm({editorIds: ALL_EDITOR_IDS})`
  // before the dialog is even visible.
  let capturedSenderId: number | null = null;

  const confirmHandler = async (
    event: IpcMainInvokeEvent,
    request: McpWiringConfirmRequest,
  ): Promise<McpWiringConfirmResult> => {
    if (!isPermittedSender(event, capturedSenderId)) {
      logger.warn('rejecting confirm — sender is not the renderer that received show', {
        capturedSenderId,
        gotSenderId: event.sender.id,
      });
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:mcp-wiring:confirm',
        reason: 'sender-mismatch',
        handler: 'mcpWiringConfirm',
        cause: { capturedSenderId, gotSenderId: event.sender.id },
      });
      return {
        ok: false,
        error: 'Consent must come from the window that displayed the dialog.',
      };
    }
    if (handled) return { ok: true };
    handled = true;
    const selectedEditors = Array.isArray(request?.editorIds)
      ? [...request.editorIds].filter((id): id is McpWiringEditorId =>
          cli.allEditorIds.includes(id as McpWiringEditorId),
        )
      : [];

    const editorsToWrite = selectedEditors;

    let results: Awaited<ReturnType<McpWiringCliSurface['writeUserMcpConfigs']>>;
    try {
      results = await cli.writeUserMcpConfigs({
        editors: editorsToWrite,
        home,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('writeUserMcpConfigs threw — marker not written', { message });
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:mcp-wiring:confirm',
        reason: 'write-mcp-configs-threw',
        handler: 'mcpWiringConfirm',
        cause: err,
      });
      // Reset `handled` on failure so user can retry from the SAME
      // still-mounted dialog (store keeps it open on ok:false).
      handled = false;
      return { ok: false, error: message };
    }

    // Deferred-marker. If any per-editor write failed, leave the marker
    // absent so the next app launch re-fires the dialog. Return
    // `ok:false` with a user-readable error so the renderer's sonner
    // toast surfaces the failure; the store keeps the dialog mounted so
    // the user can adjust selections and click Add again without waiting
    // for next-boot re-fire.
    const failedResults = results.filter((r) => r.action === 'failed');
    for (const r of failedResults) {
      logger.event({
        event: 'mcp-wiring-write-failed',
        editor: r.editorId,
        configPath: r.configPath,
        error: r.error ?? null,
      });
    }
    // A `declined` write left a present config OK can't safely edit byte-
    // untouched (a read-then-write race surfaced one the consent flow didn't
    // pre-classify). It is neither a failure (don't block the marker / re-fire
    // the dialog) nor a success — emit the bounded decline signal so the
    // decision is observable, and exclude the editor from the marker below so we
    // never record an editor we didn't actually wire as configured.
    for (const r of results) {
      if (r.action !== 'declined') continue;
      logger.event(
        buildMcpConfigDeclineEvent({
          scope: 'user',
          surface: 'desktop-firstlaunch',
          editorId: r.editorId,
          reason: r.declineReason ?? 'unparseable',
        }),
      );
    }
    if (failedResults.length > 0) {
      logger.info('partial failure — marker not written; dialog will re-fire next boot');
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:mcp-wiring:confirm',
        reason: 'partial-write-failure',
        handler: 'mcpWiringConfirm',
        cause: {
          failedCount: failedResults.length,
          totalCount: results.length,
          failures: failedResults.map((r) => ({
            editor: r.editorId,
            configPath: r.configPath,
            error: r.error ?? null,
          })),
        },
      });
      // Reset handled so a same-boot retry lands.
      handled = false;
      return {
        ok: false,
        error: formatPartialFailureMessage(failedResults, results.length),
      };
    }

    // PATH leg — only when the dialog actually solicited a decision
    // (tri-state contract on `McpWiringConfirmRequest.pathInstall`). Runs
    // after the editor writes and BEFORE the marker write so a failed PATH
    // leg defers the marker like a failed editor write does: the dialog
    // stays mounted for a same-boot retry and re-fires next boot. The
    // editor writes a retry repeats are idempotent overwrites.
    const pathDecision =
      request?.pathInstall === true
        ? ('granted' as const)
        : request?.pathInstall === false
          ? ('declined' as const)
          : null;
    if (pathDecision !== null) {
      let pathResult: { ok: true } | { ok: false; error: string };
      try {
        pathResult = await pathInstall.applyConsent(pathDecision);
      } catch (err) {
        pathResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!pathResult.ok) {
        logger.event({
          event: 'mcp-wiring-path-consent-failed',
          decision: pathDecision,
          error: pathResult.error,
        });
        logIpcError({
          event: 'ipc.error',
          channel: 'ok:mcp-wiring:confirm',
          reason: 'path-consent-failed',
          handler: 'mcpWiringConfirm',
          cause: { decision: pathDecision, error: pathResult.error },
        });
        // Reset handled so a same-boot retry lands; marker stays absent so
        // the dialog re-fires next boot (deferred-marker pattern).
        handled = false;
        return {
          ok: false,
          error:
            pathDecision === 'granted'
              ? `Couldn't add ok to your PATH (${pathResult.error}). The dialog will reappear on next launch so you can retry.`
              : `Couldn't record your PATH preference (${pathResult.error}). The dialog will reappear on next launch so you can retry.`,
        };
      }
      logger.info('path consent applied', { decision: pathDecision });
    }

    // Skills leg — apply per-bundle consent when the dialog solicited a
    // decision (skill rows were offered). Runs after PATH and BEFORE the
    // marker write so a failed skills leg defers the marker like a failed
    // editor/PATH write: the dialog stays mounted for a same-boot retry and
    // re-fires next boot. `request.skills` is the checked subset; every offered
    // bundle not listed is recorded declined (and removed if present).
    if (skillDescriptors.length > 0) {
      const offeredIds = new Set(skillDescriptors.map((d) => d.id));
      const enabledIds = Array.isArray(request?.skills)
        ? request.skills.filter((id) => offeredIds.has(id))
        : [];
      let skillResult: { ok: true } | { ok: false; error: string };
      try {
        skillResult = await skills.applyConsent(enabledIds);
      } catch (err) {
        skillResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!skillResult.ok) {
        logger.event({ event: 'mcp-wiring-skill-consent-failed', error: skillResult.error });
        logIpcError({
          event: 'ipc.error',
          channel: 'ok:mcp-wiring:confirm',
          reason: 'skill-consent-failed',
          handler: 'mcpWiringConfirm',
          cause: { error: skillResult.error },
        });
        handled = false;
        return {
          ok: false,
          error: `Couldn't apply your skill choices (${skillResult.error}). The dialog will reappear on next launch so you can retry.`,
        };
      }
      // Bounded per-bundle consent telemetry (bundle is a closed enum id).
      for (const d of skillDescriptors) {
        logger.event({
          event: enabledIds.includes(d.id)
            ? 'mcp-wiring-skill-consent-granted'
            : 'mcp-wiring-skill-consent-declined',
          bundle: d.id,
        });
      }
      logger.info('skill consent applied', { enabled: enabledIds });
    }

    // Only editors we actually wired count as configured — a declined write
    // touched nothing, so recording it here would falsely claim it's set up.
    const configuredEditors = results
      .filter((r) => r.action === 'written' || r.action === 'overwritten')
      .map((r) => r.editorId);
    try {
      writeMcpStatusMarker(
        home,
        {
          configured: true,
          configuredAt: nowDate().toISOString(),
          editors: configuredEditors,
        },
        fs,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('marker write failed', { message });
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:mcp-wiring:confirm',
        reason: 'marker-write-failed',
        handler: 'mcpWiringConfirm',
        cause: err,
      });
      // Reset handled so a same-boot retry lands.
      handled = false;
      return { ok: false, error: message };
    }

    logger.info('configured', { editors: configuredEditors });
    return { ok: true };
  };

  const skipHandler = async (event: IpcMainInvokeEvent): Promise<McpWiringSkipResult> => {
    if (!isPermittedSender(event, capturedSenderId)) {
      logger.warn('rejecting skip — sender is not the renderer that received show', {
        capturedSenderId,
        gotSenderId: event.sender.id,
      });
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:mcp-wiring:skip',
        reason: 'sender-mismatch',
        handler: 'mcpWiringSkip',
        cause: { capturedSenderId, gotSenderId: event.sender.id },
      });
      return {
        ok: false,
        error: 'Consent must come from the window that displayed the dialog.',
      };
    }
    if (handled) return { ok: true };
    handled = true;
    try {
      writeMcpStatusMarker(
        home,
        {
          configured: false,
          skippedAt: nowDate().toISOString(),
        },
        fs,
      );
    } catch (err) {
      // Marker write failed (EACCES / EROFS / ENOSPC). Surface `ok:false`
      // so the renderer can fire a sonner toast — without this signal the
      // user sees the dialog close and assumes Skip persisted, then the
      // dialog re-fires next boot with no explanation. Reset `handled` so
      // the user can retry Skip from the still-mounted dialog.
      const message = err instanceof Error ? err.message : String(err);
      logger.error('skip-marker write failed', { message });
      logIpcError({
        event: 'ipc.error',
        channel: 'ok:mcp-wiring:skip',
        reason: 'skip-marker-write-failed',
        handler: 'mcpWiringSkip',
        cause: err,
      });
      handled = false;
      return {
        ok: false,
        error: `Could not record your preference (${message}). The consent dialog may reappear on next launch.`,
      };
    }
    logger.info('skipped');
    return { ok: true };
  };

  // Mount-ack handshake. The renderer-ready invoke fires AFTER React has
  // subscribed to `ok:mcp-wiring:show`, so sending show on its receipt
  // avoids the `did-finish-load` race (subscribe-order vs. send).
  // One-shot: first renderer-ready wins the dialog AND captures its
  // WebContents sender id, which confirm/skip both validate against
  // before accepting. Remove ordering: dispatch FIRST, then
  // `removeHandler` + `capturedSenderId` update only on success — so if
  // `sendToRenderer` throws (WebContents destroyed mid-handshake,
  // channel-name drift, etc.) the handler stays armed AND no binding is
  // captured, so a second renderer's signalReady invoke gets a fresh
  // attempt with fresh sender binding. Without this swap, a failed first
  // dispatch would leave the dialog permanently undeliverable until next
  // boot.
  //
  // TODO: no watchdog. Today's boot opens exactly one window (Navigator
  // OR editor — branching on lastOpenedProject) so the ordering swap
  // above bounds the failure surface tightly. Future auto-update
  // relaunch + cold-start deep-link + multi-window flows can interleave
  // window creation; if every renderer's signalReady() fails
  // (catastrophic preload bundle drift, every window destroyed before
  // React mounts), the handler stays armed indefinitely and the dialog
  // never shows for this boot. Marker stays absent → next-boot re-fire
  // still recovers, but the user gets zero same-boot signal. When
  // multi-window flows land, add a 30-60s setTimeout that emits
  // `mcp-wiring-mount-ack-timeout` via `logger.event` and either
  // fallback-broadcasts to all visible windows OR writes a skip-marker
  // so the loop doesn't re-arm forever.

  // Shared by the mount-ack handler and the mid-session immediate dispatch.
  // Routes through `sendToRenderer` (the typed wrapper) so the channel name
  // + payload shape are validated against `EventChannels['ok:mcp-wiring:show']`.
  // Returns false on dispatch failure so the caller leaves the mount-ack
  // handler armed for the next renderer.
  const dispatchShowAndBind = (target: McpWiringDispatchTarget): boolean => {
    try {
      sendToRenderer(target, 'ok:mcp-wiring:show', {
        detectedEditors: detections,
        pathInstall: pathDescriptor,
        globalSkills: skillDescriptors,
      });
      logger.info('dispatched show to renderer', {
        detectedCount: detections.length,
        senderId: target.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('show dispatch failed — handler remains armed for next renderer', {
        message,
      });
      return false;
    }
    // Successful dispatch — bind the sender id AND drop the one-shot now
    // so a second renderer's signalReady doesn't double-fire the show
    // event. Binding must be set BEFORE handler removal so a confirm
    // arriving concurrently on the event loop sees the captured id.
    capturedSenderId = target.id;
    try {
      ipcMain.removeHandler('ok:mcp-wiring:renderer-ready');
    } catch {
      // best-effort; the handler may have been removed by destroy() racing
    }
    return true;
  };

  // `event.sender` is the same `WebContents` the renderer mount-ack arrived
  // from — i.e. the window that called `okDesktop.mcpWiring.signalReady()`,
  // guaranteeing the `McpConsentDialog` subscriber is mounted when the
  // event lands.
  const rendererReadyHandler = (event: IpcMainInvokeEvent): undefined => {
    dispatchShowAndBind(event.sender);
    return undefined;
  };

  // Register via the typed `createHandler` wrapper (not raw
  // `ipcMain.handle`). Handler parameters are typed against
  // `RequestChannels[K]['args']` rather than `...args: unknown[]` so a
  // future channel-shape change produces a compile error at the handler
  // signature, not a silent `.as` cast. Teardown still calls
  // `ipcMain.removeHandler` directly — that primitive isn't part of the
  // banned surface.
  const register = createHandler(ipcMain as IpcMain);
  register('ok:mcp-wiring:confirm', confirmHandler);
  register('ok:mcp-wiring:skip', skipHandler);
  register('ok:mcp-wiring:renderer-ready', rendererReadyHandler);

  // Mid-session re-trigger: dispatch straight to the already-loaded window.
  // Ordering matters — renderer-ready is registered first so a failed
  // immediate dispatch leaves the mount-ack fallback armed.
  const immediateDispatched =
    immediateDispatchTarget !== undefined && dispatchShowAndBind(immediateDispatchTarget);

  if (!immediateDispatched) {
    logger.info('armed — waiting for renderer mount-ack', {
      detectedCount: detections.filter((d) => d.detected).length,
    });
  }

  let destroyed = false;
  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      try {
        ipcMain.removeHandler('ok:mcp-wiring:confirm');
      } catch (err) {
        logger.warn('removeHandler(confirm) threw', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        ipcMain.removeHandler('ok:mcp-wiring:skip');
      } catch (err) {
        logger.warn('removeHandler(skip) threw', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        ipcMain.removeHandler('ok:mcp-wiring:renderer-ready');
      } catch (err) {
        logger.warn('removeHandler(renderer-ready) threw', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    get armed(): boolean {
      return !destroyed;
    },
  };
}

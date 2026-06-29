
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
  buildMcpConfigMigrateEvent,
  type EditorMcpTarget,
  isEntryUpToDate,
  type McpEntryClassification,
} from '@inkeep/open-knowledge';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type {
  McpWiringConfirmRequest,
  McpWiringConfirmResult,
  McpWiringEditorDetection,
  McpWiringEditorId,
  McpWiringSkipResult,
} from '../shared/ipc-channels.ts';
import { createHandler } from '../shared/ipc-handler.ts';
import { type SendableWebContents, sendToRenderer } from '../shared/ipc-send.ts';
import { logIpcError } from './ipc-log.ts';

const MCP_STATUS_DIR_NAME = '.ok';
const MCP_STATUS_FILE_NAME = 'mcp-status.json';

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

export interface McpWiringFsOps {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, content: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
}

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

function mcpStatusMarkerPath(home: string): string {
  return join(home, MCP_STATUS_DIR_NAME, MCP_STATUS_FILE_NAME);
}

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
    try {
      fs.unlinkSync(tmpPath);
    } catch {
    }
    throw err;
  }
}

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


function isPermittedSender(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  capturedSenderId: number | null,
): boolean {
  if (capturedSenderId === null) return false;
  return event.sender.id === capturedSenderId;
}

interface IpcMainLike extends Pick<IpcMain, 'handle' | 'removeHandler'> {}

export interface McpWiringDispatchTarget extends SendableWebContents {
  readonly id: number;
}

export interface McpWiringCliSurface {
  detectInstalledEditors(cwd: string, home?: string): McpWiringEditorId[];
  writeUserMcpConfigs(opts: { editors: McpWiringEditorId[]; home?: string }): Promise<
    Array<{
      editorId: McpWiringEditorId;
      label: string;
      action: 'written' | 'overwritten' | 'skipped-missing' | 'skipped-flag' | 'failed';
      configPath: string;
      serverName: string;
      error?: string;
    }>
  >;
  /** Look up an editor's existing MCP entry (format-aware). `null` when the
   *  config file is absent or has no entry for this editor. The editorId
   *  surface avoids a cross-package `EditorMcpTarget` type in this module. */
  readExistingMcpEntry(editorId: McpWiringEditorId, home: string): Record<string, unknown> | null;
  /** Discriminated classification — distinguishes 'corrupt' (file exists but
   *  unparseable or blank/whitespace) from 'no-entry' (file parses, no entry
   *  under our server name) and 'absent'. Used by startup reclaim to
   *  move-aside + rewrite corrupt files instead of no-op'ing. */
  classifyExistingMcpEntry(editorId: McpWiringEditorId, home: string): McpEntryClassification;
  allEditorIds: readonly McpWiringEditorId[];
  /** `EDITOR_TARGETS[id]` keyed by editor. Imported directly from
   *  `@inkeep/open-knowledge` so drift with the CLI's authoritative
   *  `EditorMcpTarget` shape is a compile error, not a runtime surprise. */
  editorTargets: Record<McpWiringEditorId, EditorMcpTarget>;
}

interface McpWiringLogger {
  info(msg: string, ctx?: object): void;
  warn(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
  event(payload: { event: string; [k: string]: unknown }): void;
}

const DEFAULT_LOGGER: McpWiringLogger = {
  info: (msg, ctx) => console.info('[mcp-wiring]', msg, ctx ?? ''),
  warn: (msg, ctx) => console.warn('[mcp-wiring]', msg, ctx ?? ''),
  error: (msg, ctx) => console.error('[mcp-wiring]', msg, ctx ?? ''),
  event: (payload) => console.warn(JSON.stringify(payload)),
};

interface RunMcpWiringOpts {
  isPackaged: boolean;
  executablePath: string;
  home: string;
  platform: 'darwin' | 'win32' | 'linux' | string;
  ipcMain: IpcMainLike;
  cli: McpWiringCliSurface;
  forceEnv?: string | null | undefined;
  reclaimDisableEnv?: string | null | undefined;
  forceShow?: boolean;
  immediateDispatchTarget?: McpWiringDispatchTarget;
  fs?: McpWiringFsOps;
  now?: () => Date;
  logger?: McpWiringLogger;
}

export interface RunMcpWiringHandle {
  destroy(): void;
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
    fs = defaultFsOps,
    now,
    logger = DEFAULT_LOGGER,
  } = opts;
  const nowDate = (): Date => (now ? now() : new Date());
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
  const corruptBackupFailures: Array<{ editor: McpWiringEditorId; error: string }> = [];
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
      logger.event({ event: 'mcp-wiring-repair-no-token', editor });
      continue;
    }

    if (classification.kind === 'present' && isEntryUpToDate(classification.entry)) {
      logger.event({ event: 'mcp-wiring-repair-healthy-current', editor });
      continue;
    }

    if (classification.kind === 'corrupt') {
      let configPath: string;
      try {
        configPath = cli.editorTargets[editor]?.configPath('', home) ?? '';
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        corruptBackupFailures.push({ editor, error });
        logger.event({
          event: 'mcp-wiring-repair-backup-failed',
          editor,
          error,
        });
        continue;
      }
      if (configPath === '') {
        corruptBackupFailures.push({ editor, error: 'config path unresolvable' });
        logger.event({
          event: 'mcp-wiring-repair-backup-failed',
          editor,
          error: 'config path unresolvable',
        });
        continue;
      }
      const stamp = nowDate().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${configPath}.broken-${stamp}`;
      try {
        fs.renameSync(configPath, backupPath);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        corruptBackupFailures.push({ editor, error });
        logger.event({
          event: 'mcp-wiring-repair-backup-failed',
          editor,
          configPath,
          error,
        });
        continue;
      }
      logger.event({
        event: 'mcp-wiring-repair-corrupt-backup',
        editor,
        configPath,
        backupPath,
        error: classification.error,
      });
      editorsToRepair.push(editor);
      continue;
    }

    let migrateConfigPath = '';
    try {
      migrateConfigPath = cli.editorTargets[editor]?.configPath('', home) ?? '';
    } catch {
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
  }

  if (editorsToRepair.length === 0) {
    if (corruptBackupFailures.length > 0) {
      return Promise.resolve({
        status: 'failed',
        failedEditors: corruptBackupFailures,
      } satisfies McpStartupRepairResult);
    }
    return Promise.resolve({ status: 'ok', checkedEditors: selectedEditors });
  }

  return cli
    .writeUserMcpConfigs({ editors: editorsToRepair, home })
    .then((results) => {
      const failed = results
        .filter((r) => r.action === 'failed')
        .map((r) => ({ editor: r.editorId, error: r.error }));
      for (const r of results) {
        logger.event({
          event:
            r.action === 'failed' ? 'mcp-wiring-repair-write-failed' : 'mcp-wiring-repair-repaired',
          editor: r.editorId,
          configPath: r.configPath,
          error: r.error ?? null,
        });
      }
      const allFailed = [...failed, ...corruptBackupFailures];
      if (allFailed.length > 0)
        return { status: 'failed', failedEditors: allFailed } satisfies McpStartupRepairResult;
      return {
        status: 'repaired',
        repairedEditors: editorsToRepair,
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
        failedEditors: [
          ...editorsToRepair.map((editor) => ({ editor, error: message })),
          ...corruptBackupFailures,
        ],
      } satisfies McpStartupRepairResult;
    });
}

export function runMcpWiringOnFirstLaunch(opts: RunMcpWiringOpts): RunMcpWiringHandle {
  const {
    isPackaged,
    executablePath,
    home,
    platform,
    ipcMain,
    cli,
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

  if (platform !== 'darwin') {
    logger.info('skip — platform is not darwin', { platform });
    return inertHandle;
  }

  if (!isPackaged && forceEnv !== '1') {
    logger.info('skip — app not packaged and OK_M6B_FORCE not set');
    return inertHandle;
  }

  if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath)) {
    logger.warn('skip — executablePath does not match .app/Contents/MacOS/<name> shape', {
      executablePath,
    });
    return inertHandle;
  }

  const marker = readMcpStatusMarker(home, fs);
  if (marker !== null && !forceShow) {
    logger.info('skip — marker present', { configured: marker.configured });
    return inertHandle;
  }
  if (marker !== null && forceShow) {
    logger.info('forceShow — ignoring prior marker', { configured: marker.configured });
  }

  let detections: McpWiringEditorDetection[];
  try {
    const detectedIds = new Set<McpWiringEditorId>(cli.detectInstalledEditors('', home));
    detections = cli.allEditorIds.map((id) => {
      const target = cli.editorTargets[id];
      if (!target) {
        throw new Error(`editorTargets missing entry for id=${id}`);
      }
      let willReplace = false;
      try {
        const existing = cli.readExistingMcpEntry(id, home);
        if (existing !== null) {
          willReplace = true;
        }
      } catch (err) {
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

  let handled = false;

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
      handled = false;
      return { ok: false, error: message };
    }

    const failedResults = results.filter((r) => r.action === 'failed');
    for (const r of failedResults) {
      logger.event({
        event: 'mcp-wiring-write-failed',
        editor: r.editorId,
        configPath: r.configPath,
        error: r.error ?? null,
      });
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
      handled = false;
      return {
        ok: false,
        error: formatPartialFailureMessage(failedResults, results.length),
      };
    }

    try {
      writeMcpStatusMarker(
        home,
        {
          configured: true,
          configuredAt: nowDate().toISOString(),
          editors: [...selectedEditors],
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
      handled = false;
      return { ok: false, error: message };
    }

    logger.info('configured', { editors: selectedEditors });
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


  const dispatchShowAndBind = (target: McpWiringDispatchTarget): boolean => {
    try {
      sendToRenderer(target, 'ok:mcp-wiring:show', {
        detectedEditors: detections,
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
    capturedSenderId = target.id;
    try {
      ipcMain.removeHandler('ok:mcp-wiring:renderer-ready');
    } catch {
    }
    return true;
  };

  const rendererReadyHandler = (event: IpcMainInvokeEvent): undefined => {
    dispatchShowAndBind(event.sender);
    return undefined;
  };

  const register = createHandler(ipcMain as IpcMain);
  register('ok:mcp-wiring:confirm', confirmHandler);
  register('ok:mcp-wiring:skip', skipHandler);
  register('ok:mcp-wiring:renderer-ready', rendererReadyHandler);

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

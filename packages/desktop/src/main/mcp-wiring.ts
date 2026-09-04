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
  editorConfigPathDisplay,
  editorEntryLocator,
  type McpDeclineReason,
  type McpEntryClassification,
} from '@inkeep/open-knowledge';
import { classifyMcpLauncherEntry } from '@inkeep/open-knowledge-core';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type {
  McpWiringConfirmRequest,
  McpWiringConfirmResult,
  McpWiringEditorDetection,
  McpWiringEditorId,
  McpWiringGlobalSkillDescriptor,
  McpWiringPathInstallDescriptor,
  McpWiringSkipResult,
} from '../shared/ipc-channels.ts';
import { createHandler } from '../shared/ipc-handler.ts';
import { type SendableWebContents, sendToRenderer } from '../shared/ipc-send.ts';
import { classifyInstallShape } from './install-shape.ts';
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
    } catch {}
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
      declineReason?: McpDeclineReason;
    }>
  >;
  readExistingMcpEntry(editorId: McpWiringEditorId, home: string): Record<string, unknown> | null;
  classifyExistingMcpEntry(editorId: McpWiringEditorId, home: string): McpEntryClassification;
  allEditorIds: readonly McpWiringEditorId[];
  editorTargets: Record<McpWiringEditorId, EditorMcpTarget>;
}

export interface McpWiringPathInstallSurface {
  computeDescriptor(): McpWiringPathInstallDescriptor;
  applyConsent(
    status: 'granted' | 'declined',
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface McpWiringSkillsSurface {
  computeDescriptors(): McpWiringGlobalSkillDescriptor[];
  applyConsent(
    enabledBundleIds: readonly string[],
  ): Promise<{ ok: true } | { ok: false; error: string }>;
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
  env?: Record<string, string | undefined>;
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

export interface RunMcpWiringFirstLaunchOpts extends RunMcpWiringOpts {
  pathInstall: McpWiringPathInstallSurface;
  skills: McpWiringSkillsSurface;
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
    logger = DEFAULT_LOGGER,
  } = opts;
  if (reclaimDisableEnv === '1')
    return Promise.resolve({ status: 'skipped', reason: 'reclaim-disabled' });
  if (!isPackaged && forceEnv !== '1')
    return Promise.resolve({ status: 'skipped', reason: 'dev-mode' });
  const installShape = classifyInstallShape(platform, executablePath, opts.env ?? process.env);
  if (installShape.kind === 'appimage') {
    return Promise.resolve({ status: 'skipped', reason: 'appimage-ephemeral' });
  }
  if (installShape.kind === 'unsupported') {
    return Promise.resolve({ status: 'skipped', reason: 'bad-executable-path' });
  }
  const selectedEditors = cli.allEditorIds.filter(
    (id) => cli.editorTargets[id]?.scope === 'global',
  );
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
      logger.event({ event: 'mcp-wiring-repair-no-token', editor });
      continue;
    }

    if (classification.kind === 'present') {
      const launcher = classifyMcpLauncherEntry(classification.entry);
      if (launcher.kind === 'recognized' && launcher.disposition === 'keep') {
        logger.event({ event: 'mcp-wiring-repair-healthy-current', editor });
        continue;
      }
    }

    if (classification.kind === 'decline') {
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
      let migrateConfigPath = '';
      try {
        migrateConfigPath = cli.editorTargets[editor]?.configPath('', home) ?? '';
      } catch {}
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

  if (!isPackaged && forceEnv !== '1') {
    logger.info('skip — app not packaged and OK_M6B_FORCE not set');
    return inertHandle;
  }

  const firstLaunchShape = classifyInstallShape(platform, executablePath, opts.env ?? process.env);
  if (firstLaunchShape.kind === 'appimage') {
    logger.info('skip — AppImage launch (ephemeral mount path; MCP wiring declines)');
    return inertHandle;
  }
  if (firstLaunchShape.kind === 'unsupported') {
    logger.warn('skip — executablePath does not match a supported packaged install layout', {
      executablePath,
      platform,
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
    const globalScopeIds = cli.allEditorIds.filter(
      (id) => cli.editorTargets[id]?.scope === 'global',
    );
    detections = globalScopeIds.map((id) => {
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
      return {
        id,
        label: target.label,
        detected: detectedIds.has(id),
        willReplace,
        configPath: editorConfigPathDisplay(target, home),
        entryLocator: editorEntryLocator(target),
      };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('detection failed — wiring inert for this boot', { err });
    logger.event({ event: 'mcp-wiring-detect-failed', error: message });
    return inertHandle;
  }

  let pathDescriptor: McpWiringPathInstallDescriptor;
  try {
    pathDescriptor = pathInstall.computeDescriptor();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('path-install descriptor failed — PATH row hidden for this boot', { err });
    logger.event({ event: 'mcp-wiring-path-descriptor-failed', error: message });
    pathDescriptor = { shellDetected: false, rcFilesToTouch: [], alreadyInstalled: false };
  }

  let skillDescriptors: ReturnType<McpWiringSkillsSurface['computeDescriptors']>;
  try {
    skillDescriptors = skills.computeDescriptors();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('skill descriptors failed — skill rows hidden for this boot', { err });
    logger.event({ event: 'mcp-wiring-skill-descriptors-failed', error: message });
    skillDescriptors = [];
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
      logger.error('writeUserMcpConfigs threw — marker not written', { err });
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
      handled = false;
      return {
        ok: false,
        error: formatPartialFailureMessage(failedResults, results.length),
      };
    }

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

    if (skillDescriptors.length > 0 && Array.isArray(request?.skills)) {
      const offeredIds = new Set(skillDescriptors.map((d) => d.id));
      const enabledIds = request.skills.filter((id) => offeredIds.has(id));
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
      logger.error('marker write failed', { err });
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
      const message = err instanceof Error ? err.message : String(err);
      logger.error('skip-marker write failed', { err });
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
        origin: forceShow ? 'reconfigure' : 'first-run',
        detectedEditors: detections,
        pathInstall: pathDescriptor,
        globalSkills: skillDescriptors,
      });
      logger.info('dispatched show to renderer', {
        detectedCount: detections.length,
        senderId: target.id,
      });
    } catch (err) {
      logger.error('show dispatch failed — handler remains armed for next renderer', {
        err,
      });
      return false;
    }
    capturedSenderId = target.id;
    try {
      ipcMain.removeHandler('ok:mcp-wiring:renderer-ready');
    } catch {}
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
          err,
        });
      }
      try {
        ipcMain.removeHandler('ok:mcp-wiring:skip');
      } catch (err) {
        logger.warn('removeHandler(skip) threw', {
          err,
        });
      }
      try {
        ipcMain.removeHandler('ok:mcp-wiring:renderer-ready');
      } catch (err) {
        logger.warn('removeHandler(renderer-ready) threw', {
          err,
        });
      }
    },
    get armed(): boolean {
      return !destroyed;
    },
  };
}

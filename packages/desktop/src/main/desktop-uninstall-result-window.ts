import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNINSTALL_RESULT_WAIT_TIMEOUT_MS } from '@inkeep/open-knowledge-core';
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import pino from 'pino';
import { createHandler } from '../shared/ipc-handler.ts';
import { UNINSTALL_PRELOAD_ARG } from '../shared/uninstall-preload-arg.ts';
import {
  type DesktopUninstallWindowOptions,
  desktopUninstallResultScreen,
  parseDesktopUninstallResultMessage,
  UNINSTALL_PROGRESS_READY_TIMEOUT_MS,
} from './desktop-uninstall-result.ts';
import {
  loadUninstallEntry,
  resolveUninstallEntryTarget,
  resolveUninstallWindowTheme,
} from './uninstall-window.ts';

const UNINSTALL_RENDERER_SILENCE_MS = 60_000;
const UNINSTALL_RESULT_NOTICE_DWELL_MS = 60_000;

export async function runDesktopUninstallResultWindow(
  options: DesktopUninstallWindowOptions,
): Promise<void> {
  const log = pino({ name: 'uninstall-result' }, pino.destination(2));
  try {
    await app.whenReady();
    const mainDir = dirname(fileURLToPath(import.meta.url));
    let result = options.kind === 'result' ? options : null;
    let progressShown = false;
    let progressReady = false;
    const win = new BrowserWindow({
      width: result === null ? 420 : 480,
      height: result === null ? 220 : 420,
      minWidth: 400,
      minHeight: result === null ? 220 : 360,
      resizable: result !== null,
      frame: false,
      show: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: result?.title ?? 'Uninstalling OpenKnowledge',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#ffffff',
      webPreferences: {
        preload: join(mainDir, '../preload/index.js'),
        additionalArguments: [UNINSTALL_PRELOAD_ARG],
        partition: 'ok-uninstall-result',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    let finished = false;
    let lastReadyAt = Date.now();
    let progressReadyAt = Date.now();
    let silenceTimeout: ReturnType<typeof setTimeout> | undefined;
    let resultTimeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(resultTimeout);
      clearTimeout(silenceTimeout);
      app.exit(code);
    };
    const timeout = setTimeout(() => {
      log.error('The completion window did not become ready.');
      finish(1);
    }, UNINSTALL_PROGRESS_READY_TIMEOUT_MS);
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('render-process-gone', (_event, details) => {
      log.error({ reason: details.reason }, 'The completion renderer exited unexpectedly.');
      finish(1);
    });
    const failResultWait = (reason: 'renderer-silent' | 'deadline') => {
      log.error(
        {
          reason,
          waitedMs: Date.now() - progressReadyAt,
          msSinceLastReadyRequest: Date.now() - lastReadyAt,
          resultFilePresent: existsSync(join(options.profile, 'result')),
        },
        'The completion window stopped waiting for the uninstall result.',
      );
      finish(1);
    };
    const watchRenderer = () => {
      clearTimeout(silenceTimeout);
      if (!progressReady || result !== null || finished) return;
      silenceTimeout = setTimeout(
        () => failResultWait('renderer-silent'),
        UNINSTALL_RENDERER_SILENCE_MS,
      );
    };
    const reportProgressReady = () => {
      if (!progressShown || progressReady || !win.isVisible()) return;
      try {
        writeFileSync(join(options.profile, 'ready'), 'ready');
        progressReady = true;
        progressReadyAt = Date.now();
        lastReadyAt = progressReadyAt;
        watchRenderer();
        clearTimeout(timeout);
        resultTimeout = setTimeout(() => {
          if (result !== null) return;
          failResultWait('deadline');
        }, UNINSTALL_RESULT_WAIT_TIMEOUT_MS + UNINSTALL_RESULT_NOTICE_DWELL_MS);
      } catch (error) {
        log.error({ err: error }, 'Could not report uninstall progress readiness.');
        finish(1);
      }
    };
    win.once('closed', () => finish(result === null ? 1 : 0));
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
      app.focus({ steal: true });
      reportProgressReady();
    });
    createHandler(ipcMain)('ok:uninstall:dispatch', (event, request) => {
      if (event.sender.id !== win.webContents.id)
        return { kind: 'refused', reason: 'unknown-window' };
      switch (request?.kind) {
        case 'ready': {
          lastReadyAt = Date.now();
          watchRenderer();
          if (result === null) {
            try {
              const content = readFileSync(join(options.profile, 'result'), 'utf8');
              const parsed = parseDesktopUninstallResultMessage(content);
              if (parsed === null) throw new Error('Invalid uninstall result.');
              result = { ...parsed, profile: options.profile, kind: 'result' };
              win.setMinimumSize(400, 360);
              win.setSize(480, 420);
              win.setResizable(true);
              win.setTitle(result.title);
            } catch (error) {
              if (
                !(error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
                !existsSync(options.profile)
              ) {
                log.error({ err: error }, 'Could not read the uninstall result.');
                finish(1);
              }
            }
          }
          if (result === null)
            return { kind: 'screen', screen: { kind: 'progress', awaitResult: true } };
          clearTimeout(timeout);
          clearTimeout(resultTimeout);
          clearTimeout(silenceTimeout);
          return {
            kind: 'screen',
            screen: desktopUninstallResultScreen(result),
          };
        }
        case 'progress-shown':
          progressShown = true;
          reportProgressReady();
          return { kind: 'accepted' };
        case 'notice-confirm': {
          if (result === null) return { kind: 'refused', reason: 'invalid-intent' };
          const code = result.actionLabel === 'Reveal in Finder' ? 11 : 0;
          setImmediate(() => finish(code));
          return { kind: 'accepted' };
        }
        case 'notice-cancel':
          if (result === null) return { kind: 'refused', reason: 'invalid-intent' };
          setImmediate(() => finish(0));
          return { kind: 'accepted' };
        case 'notice-reveal-log':
          if (result === null) return { kind: 'refused', reason: 'invalid-intent' };
          setImmediate(() => finish(10));
          return { kind: 'accepted' };
        case 'picker-confirm':
        case 'picker-cancel':
        case 'survey-send':
        case 'survey-skip':
          return { kind: 'refused', reason: 'invalid-intent' };
        default: {
          const exhaustive: never = request;
          log.warn({ request: exhaustive }, 'Unrecognized uninstall intent.');
          return { kind: 'refused', reason: 'invalid-intent' };
        }
      }
    });
    await loadUninstallEntry(
      win,
      resolveUninstallEntryTarget(
        {
          devServerUrl: null,
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          mainDir,
        },
        resolveUninstallWindowTheme(nativeTheme.shouldUseDarkColors),
        options.locale,
      ),
    );
  } catch (error) {
    log.error({ err: error }, 'Could not load the uninstall completion window.');
    app.exit(1);
  }
}

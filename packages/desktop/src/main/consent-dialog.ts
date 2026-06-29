import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type {
  McpWiringEditorId,
  OnboardingCancelResult,
  OnboardingConfirmRequest,
  OnboardingConfirmResult,
  OnboardingProbeContentRequest,
  OnboardingProbeContentResult,
  OnboardingShowPayload,
} from '../shared/ipc-channels.ts';
import { createHandler } from '../shared/ipc-handler.ts';
import { type SendableWebContents, sendToRenderer } from '../shared/ipc-send.ts';
import { getLogger } from './desktop-logger.ts';
import { logIpcError } from './ipc-log.ts';

export interface ConsentIpcMainLike extends Pick<IpcMain, 'handle' | 'removeHandler'> {}

type ConsentDecision =
  | { readonly outcome: 'confirm'; readonly request: OnboardingConfirmRequest }
  | { readonly outcome: 'cancel' };

interface ConsentNavigatorWebContents extends SendableWebContents {
  readonly id?: number;
}

interface RequestUserConsentDeps {
  ipcMain: ConsentIpcMainLike;
  /** WebContents of the Navigator window. The show event is sent directly to
   * this WebContents (the renderer's `onShow` listener attaches at module
   * init, so the listener is guaranteed to be in place by the time
   * `openProject` runs). The renderer-ready handshake remains as a fallback
   * for cases where the navigator is mid-reload. */
  navigator: ConsentNavigatorWebContents;
  previewContent: PreviewContentFn;
  logger?: ConsentDialogLogger;
}

interface ConsentDialogLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

const DEFAULT_LOGGER: ConsentDialogLogger = {
  info: (msg, ctx) => getLogger('consent-dialog').info(ctx ?? {}, msg),
  warn: (msg, ctx) => console.warn('[consent-dialog]', msg, ctx ?? ''),
  error: (msg, ctx) => console.error('[consent-dialog]', msg, ctx ?? ''),
};

export type PreviewContentFn = (opts: {
  projectDir: string;
  contentDir: string;
  sampleCap?: number;
}) => { totalCount: number; sample: string[]; warnings: string[] };

export const PROBE_WALK_CAP = 50_000;

function isContentDirSafe(value: string): boolean {
  if (value === '' || value === '.') return true;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.replace(/\\/g, '/').split('/');
  let depth = 0;
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      depth -= 1;
      if (depth < 0) return false;
    } else {
      depth += 1;
    }
  }
  return true;
}

const PROBE_SAMPLE_CAP = 5;

export function requestUserConsent(
  deps: RequestUserConsentDeps,
  payload: OnboardingShowPayload,
): Promise<ConsentDecision> {
  const { ipcMain, navigator, previewContent } = deps;
  const logger = deps.logger ?? DEFAULT_LOGGER;
  const register = createHandler(ipcMain as IpcMain);

  return new Promise<ConsentDecision>((resolve) => {
    let capturedSenderId: number | null = null;
    let resolved = false;

    function settle(decision: ConsentDecision): void {
      if (resolved) return;
      resolved = true;
      teardown();
      resolve(decision);
    }

    function teardown(): void {
      try {
        ipcMain.removeHandler('ok:onboarding:confirm');
      } catch (err) {
        logger.warn('removeHandler(confirm) threw', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        ipcMain.removeHandler('ok:onboarding:cancel');
      } catch (err) {
        logger.warn('removeHandler(cancel) threw', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        ipcMain.removeHandler('ok:onboarding:probe-content');
      } catch (err) {
        logger.warn('removeHandler(probe-content) threw', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        ipcMain.removeHandler('ok:onboarding:renderer-ready');
      } catch (err) {
        logger.warn('removeHandler(renderer-ready) threw', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    function isSameSender(event: IpcMainInvokeEvent): boolean {
      return capturedSenderId !== null && event.sender.id === capturedSenderId;
    }

    register(
      'ok:onboarding:confirm',
      async (
        event: IpcMainInvokeEvent,
        request: OnboardingConfirmRequest,
      ): Promise<OnboardingConfirmResult> => {
        if (!isSameSender(event)) {
          logger.warn('rejecting confirm — sender mismatch', {
            capturedSenderId,
            gotSenderId: event.sender.id,
          });
          logIpcError({
            event: 'ipc.error',
            channel: 'ok:onboarding:confirm',
            reason: 'sender-mismatch',
            handler: 'onboardingConfirm',
            cause: { capturedSenderId, gotSenderId: event.sender.id },
          });
          return {
            ok: false,
            error: 'Consent must come from the window that displayed the dialog.',
          };
        }
        if (resolved) return { ok: true };
        const validated = validateConfirmRequest(request, payload);
        if (!validated.ok) {
          logIpcError({
            event: 'ipc.error',
            channel: 'ok:onboarding:confirm',
            reason: 'invalid-request',
            handler: 'onboardingConfirm',
            cause: { message: validated.error },
          });
          return { ok: false, error: validated.error };
        }
        settle({ outcome: 'confirm', request: validated.value });
        return { ok: true };
      },
    );

    register(
      'ok:onboarding:cancel',
      async (event: IpcMainInvokeEvent): Promise<OnboardingCancelResult> => {
        if (!isSameSender(event)) {
          logger.warn('rejecting cancel — sender mismatch', {
            capturedSenderId,
            gotSenderId: event.sender.id,
          });
          logIpcError({
            event: 'ipc.error',
            channel: 'ok:onboarding:cancel',
            reason: 'sender-mismatch',
            handler: 'onboardingCancel',
            cause: { capturedSenderId, gotSenderId: event.sender.id },
          });
          return {
            ok: false,
            error: 'Cancel must come from the window that displayed the dialog.',
          };
        }
        if (resolved) return { ok: true };
        settle({ outcome: 'cancel' });
        return { ok: true };
      },
    );

    register(
      'ok:onboarding:probe-content',
      async (
        event: IpcMainInvokeEvent,
        request: OnboardingProbeContentRequest,
      ): Promise<OnboardingProbeContentResult> => {
        if (!isSameSender(event)) {
          logIpcError({
            event: 'ipc.error',
            channel: 'ok:onboarding:probe-content',
            reason: 'sender-mismatch',
            handler: 'onboardingProbeContent',
            cause: { capturedSenderId, gotSenderId: event.sender.id },
          });
          return { ok: false, error: 'Probe must come from the dialog window.' };
        }
        const result = await runProbe(previewContent, payload.projectDir, request);
        if (!result.ok) {
          logIpcError({
            event: 'ipc.error',
            channel: 'ok:onboarding:probe-content',
            reason: result.error,
            handler: 'onboardingProbeContent',
          });
        }
        return result;
      },
    );

    register('ok:onboarding:renderer-ready', (event: IpcMainInvokeEvent): undefined => {
      if (capturedSenderId !== null && event.sender.id !== capturedSenderId) {
        return undefined;
      }
      try {
        sendToRenderer(event.sender, 'ok:onboarding:show', payload);
      } catch (err) {
        logger.error('show dispatch failed — handler stays armed for retry', {
          message: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
      capturedSenderId = event.sender.id;
      return undefined;
    });

    if (navigator.isDestroyed?.() === true) {
      settle({ outcome: 'cancel' });
      return;
    }

    if (typeof navigator.id === 'number') {
      try {
        sendToRenderer(navigator, 'ok:onboarding:show', payload);
        capturedSenderId = navigator.id;
      } catch (err) {
        logger.error('proactive show dispatch failed — falling back to renderer-ready', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
}

interface ValidatedRequest {
  ok: true;
  value: OnboardingConfirmRequest;
}
interface InvalidRequest {
  ok: false;
  error: string;
}

function validateConfirmRequest(
  request: OnboardingConfirmRequest,
  payload: OnboardingShowPayload,
): ValidatedRequest | InvalidRequest {
  if (typeof request.initGit !== 'boolean') {
    return { ok: false, error: 'invalid initGit' };
  }
  if (typeof request.contentDir !== 'string') {
    return { ok: false, error: 'invalid contentDir' };
  }
  if (!isContentDirSafe(request.contentDir)) {
    return { ok: false, error: 'Content directory must be inside the project' };
  }
  if (typeof request.additionalIgnores !== 'string') {
    return { ok: false, error: 'invalid additionalIgnores' };
  }
  if (!Array.isArray(request.editorIds)) {
    return { ok: false, error: 'invalid editorIds' };
  }
  const offeredIds = new Set<McpWiringEditorId>(payload.editorOptions.map((e) => e.id));
  const editorIds = request.editorIds.filter((id): id is McpWiringEditorId =>
    offeredIds.has(id as McpWiringEditorId),
  );
  const sharing: 'shared' | 'local-only' =
    request.sharing === 'local-only' ? 'local-only' : 'shared';
  return {
    ok: true,
    value: {
      initGit: request.initGit,
      contentDir: request.contentDir,
      additionalIgnores: request.additionalIgnores,
      editorIds,
      sharing,
    },
  };
}

export async function runProbe(
  previewContent: PreviewContentFn,
  projectDir: string,
  request: OnboardingProbeContentRequest,
): Promise<OnboardingProbeContentResult> {
  if (!isContentDirSafe(request.contentDir)) {
    return { ok: false, error: 'Content directory must be inside the project' };
  }
  const target =
    request.contentDir === '.' || request.contentDir === ''
      ? projectDir
      : join(projectDir, request.contentDir);
  if (!existsSync(target)) {
    return { ok: false, error: `Path does not exist: ${request.contentDir || '.'}` };
  }
  await new Promise<void>((r) => setImmediate(r));
  try {
    const truncated = await walkExceedsCap(target, PROBE_WALK_CAP);
    if (truncated) {
      return { ok: true, count: PROBE_WALK_CAP, sample: [], truncated: true };
    }
    const result = previewContent({
      projectDir,
      contentDir: target,
      sampleCap: PROBE_SAMPLE_CAP,
    });
    return {
      ok: true,
      count: result.totalCount,
      sample: result.sample,
      truncated: false,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'probe failed' };
  }
}

const CHUNK_YIELD_EVERY = 1000;

export async function walkExceedsCap(
  root: string,
  cap: number,
  options: {
    readonly readdirImpl?: (path: string) => Promise<readonly Dirent[]>;
    readonly chunkYieldEvery?: number;
  } = {},
): Promise<boolean> {
  const readdirImpl = options.readdirImpl ?? ((p: string) => readdir(p, { withFileTypes: true }));
  const chunkYieldEvery = options.chunkYieldEvery ?? CHUNK_YIELD_EVERY;
  let count = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: readonly Dirent[];
    try {
      entries = await readdirImpl(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EMFILE' || code === 'ENFILE') return true;
      continue;
    }
    for (const entry of entries) {
      count += 1;
      if (count > cap) return true;
      if (count % chunkYieldEvery === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        stack.push(join(dir, entry.name));
      }
    }
  }
  return false;
}

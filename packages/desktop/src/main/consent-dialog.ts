/**
 * Per-project consent dialog — main-side orchestration.
 *
 * Routes the consent-dialog flow over the typed IPC surface
 * (`ok:onboarding:*`). Mirrors the first-launch MCP-wiring mount-ack
 * handshake from `mcp-wiring.ts`: the renderer's `signalReady` invoke
 * captures the `WebContents` sender id, which subsequent confirm/cancel
 * events MUST match. Per-pick lifecycle: each call to `requestUserConsent`
 * arms a fresh session and tears it down on resolve.
 *
 * The probe-content handler stays registered for the session's full lifetime
 * because the dialog can re-probe whenever the user types into Content
 * directory. Bounded preview walk lives in `bounded-preview.ts`.
 */

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

/**
 * Structurally-compatible subset of Electron's `IpcMain`. Declared inline so
 * tests can inject a stub without pulling in the real Electron runtime.
 * Mirrors `IpcMainLike` in `mcp-wiring.ts`.
 */
export interface ConsentIpcMainLike extends Pick<IpcMain, 'handle' | 'removeHandler'> {}

/**
 * Decision the dialog returns when it resolves. `request` mirrors the IPC
 * shape but is the caller's contract — main orchestration consumes it to
 * drive ensureProjectGit / initContent / writeProjectAiIntegrations.
 */
type ConsentDecision =
  | { readonly outcome: 'confirm'; readonly request: OnboardingConfirmRequest }
  | { readonly outcome: 'cancel' };

/**
 * Navigator WebContents — accepts a SendableWebContents plus an optional `id`
 * for the proactive-show path (see requestUserConsent). Real Electron
 * WebContents always has `.id`; test fakes can omit it and fall back to the
 * renderer-ready handshake.
 */
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
  /** `previewContent` from `@inkeep/open-knowledge` — bounded by `runProbe`. */
  previewContent: PreviewContentFn;
  logger?: ConsentDialogLogger;
}

interface ConsentDialogLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

// `info` routes through the pino desktop logger; `warn`/`error` deliberately
// stay on console.warn/error (the structured-JSON console style is its own
// convention — see AGENTS.md "Logging conventions").
const DEFAULT_LOGGER: ConsentDialogLogger = {
  info: (msg, ctx) => getLogger('consent-dialog').info(ctx ?? {}, msg),
  warn: (msg, ctx) => console.warn('[consent-dialog]', msg, ctx ?? ''),
  error: (msg, ctx) => console.error('[consent-dialog]', msg, ctx ?? ''),
};

/** Subset of `previewContent` we actually call — keeps the dep narrow for tests. */
export type PreviewContentFn = (opts: {
  projectDir: string;
  contentDir: string;
  sampleCap?: number;
}) => { totalCount: number; sample: string[]; warnings: string[] };

/**
 * 50,000-entry cap on the file-walk for the live preview probe. Larger
 * trees render as `≥ 50,000` and the walk stops early. The cap is a
 * generous upper bound for "interactive" — the preview should feel
 * responsive even on huge content trees.
 */
export const PROBE_WALK_CAP = 50_000;

/**
 * `..`-escape detector for renderer-supplied `contentDir`. Mirrors the
 * renderer's `isContentDirSafe` (segment-walk with depth counter) so a
 * compromised renderer can't bypass UI validation and probe / scaffold
 * outside the project. Pure: no fs reads, no `path.resolve` (which would
 * couple us to the host's path separator and miss `\\`-form attacks).
 */
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

/** Sample cap on the dialog file-count preview line. */
const PROBE_SAMPLE_CAP = 5;

/**
 * Arm the consent dialog for one Navigator pick. Resolves with the user's
 * decision once they click Start (`outcome: 'confirm'`) or Cancel
 * (`outcome: 'cancel'`). Caller is responsible for spawning the editor /
 * returning to the Navigator based on the decision.
 *
 * Throws only when `navigator` is destroyed before the mount-ack arrives;
 * callers catch and surface via the existing collision-dialog path.
 */
export function requestUserConsent(
  deps: RequestUserConsentDeps,
  payload: OnboardingShowPayload,
): Promise<ConsentDecision> {
  const { ipcMain, navigator, previewContent } = deps;
  const logger = deps.logger ?? DEFAULT_LOGGER;
  // `createHandler` is typed against the full `IpcMain`, but the only
  // methods used at runtime are `handle` + `removeHandler` — both present on
  // `ConsentIpcMainLike`. The cast keeps the test-injectable seam.
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
        // projectDir is pinned to the captured show payload — never read from
        // the request. A compromised renderer that fakes a `projectDir` field
        // is ignored at the type level (not on the wire) and at the runtime
        // boundary (we pass payload.projectDir explicitly).
        const result = await runProbe(previewContent, payload.projectDir, request);
        if (!result.ok) {
          // Pair runProbe's three failure paths (content-dir-unsafe,
          // path-not-exists, probe-threw) with structured logging so this
          // channel matches the same observability discipline as every other
          // failure path in the PR. Without this, the meta-test's literal
          // `return { ok: false }` AST scope (which doesn't follow
          // `return runProbe(...)` CallExpressions) would let the only gap in
          // the PR's structured-logging coverage slip past.
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
        // A foreign window's mount-ack landed after we already armed for the
        // original sender. Ignore — the original window owns this session.
        return undefined;
      }
      // Re-dispatch even when capturedSenderId already matches: the proactive
      // `webContents.send` may have fired before the renderer bound its
      // `ok:onboarding:show` listener (preload + renderer.attach race), in
      // which case Electron silently drops the payload. Replaying on every
      // matching ack is safe — the renderer's mount-once-only logic guarantees
      // the dialog opens at most once. The handler stays armed until
      // teardown() so a navigator reload mid-dialog can re-arm.
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

    // Guard: navigator destroyed before mount-ack landed → resolve as cancel
    // so the caller doesn't hang waiting for an unreachable renderer.
    // `isDestroyed` is optional on `SendableWebContents` (test stubs may
    // omit); skip the check when absent.
    if (navigator.isDestroyed?.() === true) {
      settle({ outcome: 'cancel' });
      return;
    }

    // Proactive show: send directly to the navigator's WebContents and
    // capture its id eagerly so confirm/cancel/probe events from the
    // navigator are accepted before any renderer-ready ack arrives. Without
    // this, the renderer-ready handshake alone never fires (signalReady
    // runs once at module-init, before openProject registers the handler)
    // and the dialog stays mounted-but-empty. The renderer-ready handler
    // stays armed as a fallback for two cases: (a) test stubs that omit
    // `.id` on the injected WebContents; (b) the production race where the
    // proactive `webContents.send` fires before the renderer binds an
    // `ok:onboarding:show` listener, dropping the payload — the renderer's
    // subsequent signalReady triggers a re-dispatch via event.sender.
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

/**
 * Validate the incoming confirm request and clamp `editorIds` to the show
 * payload's offered set. Renderer-side checks are the primary defense; this
 * is the wire-level safety net.
 */
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
  // Sharing-mode posture: validate against the closed set; default to
  // `shared` on any non-matching value (defensive: a renderer bypass would
  // not be able to inject `'local-only'` without sending an exact string,
  // but the safer default is the team-friendly one).
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

/**
 * Run the bounded file-count preview. Wraps `previewContent` with a 50,000-
 * entry cap on the walk; truncated runs surface `truncated: true` so the
 * dialog can render `≥ 50,000`. Failures resolve to `{ ok: false, error }`
 * — never throw, never block the dialog.
 *
 * `projectDir` is supplied by main from the captured show payload — never
 * from the renderer's request. The wire shape carries `contentDir` only;
 * pinning the walk root in the closure prevents a compromised renderer from
 * redirecting the probe outside the picked project.
 */
export async function runProbe(
  previewContent: PreviewContentFn,
  projectDir: string,
  request: OnboardingProbeContentRequest,
): Promise<OnboardingProbeContentResult> {
  // Reject `..`-escapes server-side — defense in depth against a renderer
  // that bypassed `isContentDirSafe` (compromise / future bug). Probe only
  // returns metadata, but file counts + 5-file samples outside the project
  // are still a leak.
  if (!isContentDirSafe(request.contentDir)) {
    return { ok: false, error: 'Content directory must be inside the project' };
  }
  // Resolve content dir relative to project; if the path doesn't exist yet
  // (Start hasn't fired so .ok/ doesn't exist either, but the user-typed
  // sub-path may be absent) surface `Preview unavailable` and let the user
  // continue.
  const target =
    request.contentDir === '.' || request.contentDir === ''
      ? projectDir
      : join(projectDir, request.contentDir);
  if (!existsSync(target)) {
    return { ok: false, error: `Path does not exist: ${request.contentDir || '.'}` };
  }
  // Yield to setImmediate so the IPC reply doesn't synchronously block the
  // main loop on huge trees.
  await new Promise<void>((r) => setImmediate(r));
  try {
    // Trial walk with a cap — bail when we hit the limit, surface as
    // `truncated`. We can't pass the cap to `previewContent` directly
    // (it doesn't accept one today), so we run a lightweight pre-walk
    // count first and downgrade to `previewContent` only when under cap.
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

/**
 * Cheap pre-walk that returns true once the entry cap is exceeded. Doesn't
 * apply ignore rules — those are previewContent's job. The point is to
 * short-circuit before `previewContent` does its full ignore-aware walk on
 * a 1M-file tree.
 *
 * Async + chunked: yields the Electron main event loop via `setImmediate`
 * every `chunkYieldEvery` entries so other IPC, paint, and key events can
 * interleave. A synchronous walk over 50k entries can block main long
 * enough to violate the dialog-show latency budget on slow disks.
 *
 * `readdirImpl` is injectable for tests so a 5k-entry walk can be
 * synthesized without touching the real filesystem.
 */
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
      // EMFILE / ENFILE = process- or system-wide file-descriptor exhaustion.
      // Fires precisely when the tree IS large enough to exhaust descriptors,
      // so the true count almost certainly exceeds `cap`. Returning `false`
      // here would (a) misreport a low file count in the dialog preview and
      // (b) compound the resource pressure when downstream `previewContent`
      // attempts a second walk on the same exhausted-fd tree. Conservatively
      // assume the cap is exceeded. Per-directory `EACCES` etc. continue past
      // the inaccessible subtree (the original behavior).
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
        // Skip well-known noise directories so we don't blow the cap on
        // node_modules in non-OK projects (the actual preview filter
        // ignores them, but we want a faithful shortcut).
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        stack.push(join(dir, entry.name));
      }
    }
  }
  return false;
}

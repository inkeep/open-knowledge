/**
 * Unit tests for `useHandoffDispatch` — exercises the pure `runHandoffDispatch`
 * helper with recording doubles. Matches the repo convention (no
 * `@testing-library/react` / `happy-dom`; Playwright covers live UI flows).
 *
 * Covers acceptance criteria:
 *   - Success outcome renders success toast, records `outcome:'ok'`
 *   - Failure outcome renders error toast + retry action, records
 *     `outcome:'error'` with the failure reason
 *   - Retry action re-invokes dispatch with the same `(target, input)` pair
 *   - Both paths call `recordHandoff` exactly once per attempt (retry ⇒ +1)
 *   - The scope-specific directive prompt is composed before dispatch
 *   - `host` telemetry field reflects `isElectronHost()`
 *   - Default deps wire production bindings without error
 */

import { describe, expect, mock, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import type { HandoffOutcome, HandoffPayload, HandoffTarget } from '@inkeep/open-knowledge-core';
import {
  composeTerminalBareLaunchPrompt,
  OK_TERMINAL_SURFACE_PREAMBLE,
  withSkillPointer,
} from '@inkeep/open-knowledge-core';
import type {
  HandoffDispatchDeps,
  HandoffDispatchInput,
  ToastAction,
  ToastSurface,
} from './useHandoffDispatch';

function sampleInput(overrides: Partial<HandoffDispatchInput> = {}): HandoffDispatchInput {
  return {
    docContext: { relativePath: 'specs/foo/SPEC.md' },
    projectDir: '/Users/andrew/Documents/code/open-knowledge',
    docPath: '/Users/andrew/Documents/code/open-knowledge/specs/foo/SPEC.md',
    ...overrides,
  };
}

interface ErrorToastCall {
  readonly message: string;
  readonly action?: ToastAction;
}

interface RecordingToast extends ToastSurface {
  readonly successCalls: string[];
  readonly errorCalls: ErrorToastCall[];
}

function recordingToast(): RecordingToast {
  const successCalls: string[] = [];
  const errorCalls: ErrorToastCall[] = [];
  return {
    successCalls,
    errorCalls,
    success(message) {
      successCalls.push(message);
    },
    error(message, options) {
      errorCalls.push({ message, action: options?.action });
    },
  };
}

function buildDeps(
  overrides: Partial<HandoffDispatchDeps> = {},
): HandoffDispatchDeps & { toast: RecordingToast } {
  const toast = recordingToast();
  const defaults: HandoffDispatchDeps = {
    dispatchHandoff: mock(async (_payload: HandoffPayload) => ({ ok: true }) as HandoffOutcome),
    recordHandoff: mock(async (_line) => {}),
    toast,
    now: () => new Date('2026-04-22T03:00:00.000Z'),
    isElectronHost: () => true,
    getDisplayName: (target: HandoffTarget) =>
      target === 'claude-cowork'
        ? 'Claude Cowork'
        : target === 'claude-code'
          ? 'Claude'
          : target === 'codex'
            ? 'Codex'
            : 'Cursor',
    // Default to `already-installed` so existing tests exercise the URL
    // dispatch path; install-gate-specific tests override this.
    ensureCoworkSkillInstalled: mock(async () => ({ kind: 'already-installed' }) as const),
    // Default true to match `defaultHandoffDispatchDeps()` and the cold-start
    // fallback in the hook; tests covering the `false` branch override this.
    autoOpen: true,
  };
  // `toast` is the test seam — placed last so the intersection's
  // `RecordingToast` survives any `overrides.toast` (callers should override
  // *behavior* deps, not the toast double itself).
  return { ...defaults, ...overrides, toast };
}

describe('useHandoffDispatch module surface', () => {
  test('exports the hook + helper + deps factory + copy helpers', async () => {
    const mod = await import('./useHandoffDispatch');
    expect(typeof mod.useHandoffDispatch).toBe('function');
    expect(typeof mod.runHandoffDispatch).toBe('function');
    expect(typeof mod.defaultHandoffDispatchDeps).toBe('function');
    expect(typeof mod.successToastMessage).toBe('function');
    expect(typeof mod.errorToastMessage).toBe('function');
    expect(typeof mod.getDisplayNameDefault).toBe('function');
    expect(typeof mod.isElectronHostDefault).toBe('function');
  });
});

describe('successToastMessage / errorToastMessage — exact copy', () => {
  test('success copy matches spec §5.1 E5a', async () => {
    const { successToastMessage } = await import('./useHandoffDispatch');
    expect(successToastMessage('Claude Cowork')).toBe('Opened in Claude Cowork.');
    expect(successToastMessage('Codex')).toBe('Opened in Codex.');
  });

  test('error copy uses plain ASCII apostrophe + em-dash on first attempt', async () => {
    const { errorToastMessage } = await import('./useHandoffDispatch');
    expect(errorToastMessage('Cursor')).toBe("Couldn't reach Cursor — try again?");
    expect(errorToastMessage('Cursor', 1)).toBe("Couldn't reach Cursor — try again?");
  });

  test('error copy escalates on attempt 2 (still-not-reached shape)', async () => {
    const { errorToastMessage } = await import('./useHandoffDispatch');
    expect(errorToastMessage('Cursor', 2)).toBe("Still couldn't reach Cursor — try one more time?");
  });

  test('error copy on final attempt omits the "try again?" question and names a retry delay', async () => {
    // bounded retry cap. The final-attempt copy must be distinct so
    // the user is not trapped in a loop of identical "try again?" toasts.
    const { errorToastMessage, MAX_DISPATCH_ATTEMPTS } = await import('./useHandoffDispatch');
    expect(errorToastMessage('Cursor', MAX_DISPATCH_ATTEMPTS)).toBe(
      "Couldn't reach Cursor — please try again later.",
    );
  });

  test('retryActionLabel returns Retry / Try one more time / null across attempts', async () => {
    const { retryActionLabel, MAX_DISPATCH_ATTEMPTS } = await import('./useHandoffDispatch');
    expect(MAX_DISPATCH_ATTEMPTS).toBe(3);
    expect(retryActionLabel(1)).toBe('Retry');
    expect(retryActionLabel(2)).toBe('Try one more time');
    expect(retryActionLabel(3)).toBeNull();
    expect(retryActionLabel(4)).toBeNull();
  });
});

describe('getDisplayNameDefault — KNOWN_TARGETS lookup', () => {
  test('maps each v0 target id to its SPEC §7.2 display name', async () => {
    const { getDisplayNameDefault } = await import('./useHandoffDispatch');
    expect(getDisplayNameDefault('claude-cowork')).toBe('Claude Cowork');
    expect(getDisplayNameDefault('claude-code')).toBe('Claude');
    expect(getDisplayNameDefault('codex')).toBe('Codex');
    expect(getDisplayNameDefault('cursor')).toBe('Cursor');
  });

  test('falls back to target id for an unknown cast value', async () => {
    const { getDisplayNameDefault } = await import('./useHandoffDispatch');
    expect(getDisplayNameDefault('zed' as HandoffTarget)).toBe('zed');
  });
});

describe('isElectronHostDefault — host classifier', () => {
  test('returns false when no windowLike is supplied in a non-DOM context', async () => {
    const { isElectronHostDefault } = await import('./useHandoffDispatch');
    expect(isElectronHostDefault(undefined)).toBe(false);
  });

  test('returns false when okDesktop is absent', async () => {
    const { isElectronHostDefault } = await import('./useHandoffDispatch');
    expect(isElectronHostDefault({})).toBe(false);
  });

  test('returns true when okDesktop is any non-nullish value', async () => {
    const { isElectronHostDefault } = await import('./useHandoffDispatch');
    expect(isElectronHostDefault({ okDesktop: { shell: {} } })).toBe(true);
  });
});

describe('runHandoffDispatch — success path', () => {
  test('renders success toast and records one ok stats line', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps();
    const input = sampleInput();

    const outcome = await runHandoffDispatch('claude-cowork', input, deps);

    expect(outcome).toEqual({ ok: true });
    expect(deps.toast.successCalls).toEqual(['Opened in Claude Cowork.']);
    expect(deps.toast.errorCalls).toEqual([]);
    expect(deps.recordHandoff).toHaveBeenCalledTimes(1);
    expect(deps.recordHandoff).toHaveBeenCalledWith({
      target: 'claude-cowork',
      host: 'electron',
      outcome: 'ok',
      ts: '2026-04-22T03:00:00.000Z',
    });
  });

  test('passes a fully-formed HandoffPayload (target + paths + file prompt with autoOpen=true trailer) to dispatchHandoff', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps();
    const input = sampleInput({
      docContext: { relativePath: 'specs/2026-04-21-open-in-agent-desktop/SPEC.md' },
      projectDir: '/tmp/demo-project',
      docPath: '/tmp/demo-project/specs/2026-04-21-open-in-agent-desktop/SPEC.md',
    });

    await runHandoffDispatch('codex', input, deps);

    expect(deps.dispatchHandoff).toHaveBeenCalledTimes(1);
    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.target).toBe('codex');
    expect(payload.projectDir).toBe('/tmp/demo-project');
    expect(payload.docPath).toBe(
      '/tmp/demo-project/specs/2026-04-21-open-in-agent-desktop/SPEC.md',
    );
    // File template — verbatim. Interpolated paths are wrapped in backticks
    // per the prompt-injection defense in `sanitizePathForPrompt`. autoOpen
    // defaults to true, so the trailing "Open the OK editor in web view." directive is
    // present; legacy " in web view" suffix is dropped.
    expect(payload.prompt).toBe(
      withSkillPointer(
        "Let's work on `specs/2026-04-21-open-in-agent-desktop/SPEC.md` using OpenKnowledge. Open the OK editor in web view.",
      ),
    );
  });

  test('records host="web" when isElectronHost() is false', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps({ isElectronHost: () => false });

    await runHandoffDispatch('codex', sampleInput(), deps);

    expect(deps.recordHandoff).toHaveBeenCalledTimes(1);
    expect(deps.recordHandoff).toHaveBeenCalledWith({
      target: 'codex',
      host: 'web',
      outcome: 'ok',
      ts: '2026-04-22T03:00:00.000Z',
    });
  });

  test('project-scoped (docContext: null, no folderRelativePath) emits empty-space prompt + empty docPath', async () => {
    // Pins the runtime contract that empty-state cards rely on: when the
    // helper-built input has docContext null AND no folderRelativePath,
    // runHandoffDispatch composes the empty-space directive prompt so the
    // target editor opens prefilled. docPath stays '' so the URL builders
    // use the project-scope URL shape.
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const { composeEmptySpacePrompt } = await import('@inkeep/open-knowledge-core');
    const deps = buildDeps();
    const input: HandoffDispatchInput = {
      docContext: null,
      projectDir: '/Users/sarah/proj',
      docPath: '',
    };

    await runHandoffDispatch('codex', input, deps);

    expect(deps.dispatchHandoff).toHaveBeenCalledTimes(1);
    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.target).toBe('codex');
    expect(payload.projectDir).toBe('/Users/sarah/proj');
    expect(payload.docPath).toBe('');
    expect(payload.prompt).toBe(withSkillPointer(composeEmptySpacePrompt(true)));
    // autoOpen defaults to true → trailer present, legacy " in web view"
    // suffix dropped. The dispatch funnel prepends the standing skill pointer.
    expect(payload.prompt).toBe(
      withSkillPointer(
        "Let's work on this project using OpenKnowledge. Open the OK editor in web view.",
      ),
    );
  });

  test('folder-scoped (docContext: null, folderRelativePath set) emits folder prompt with autoOpen=true trailer', async () => {
    // Folder-scope dispatch: the input carries folderRelativePath as the
    // discriminator between folder vs empty-space; runHandoffDispatch picks
    // composeFolderPrompt(folderRelativePath) and threads it into payload.
    // projectDir is contentDir (project root) — folder scope conveys focus
    // via the directive prompt, not via cwd. See `buildFolderHandoffInput`.
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const { composeFolderPrompt } = await import('@inkeep/open-knowledge-core');
    const deps = buildDeps();
    const input: HandoffDispatchInput = {
      docContext: null,
      folderRelativePath: 'specs/2026-05-16-sidebar-context-menus',
      projectDir: '/Users/sarah/proj',
      docPath: '',
    };

    await runHandoffDispatch('codex', input, deps);

    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.target).toBe('codex');
    expect(payload.projectDir).toBe('/Users/sarah/proj');
    expect(payload.docPath).toBe('');
    expect(payload.prompt).toBe(
      withSkillPointer(composeFolderPrompt('specs/2026-05-16-sidebar-context-menus', true)),
    );
    expect(payload.prompt).toBe(
      withSkillPointer(
        "Let's work on the `specs/2026-05-16-sidebar-context-menus` folder using OpenKnowledge. Open the OK editor in web view.",
      ),
    );
  });
});

describe('runHandoffDispatch — autoOpen=false honors the user preference', () => {
  test('file scope: prompt drops the "Open the OK editor in web view." trailer when autoOpen=false', async () => {
    // autoOpen=false means the user has opted out of agent-driven preview
    // navigation. The directive prompt must not contradict that on the
    // receiving agent's first turn.
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps({ autoOpen: false });
    await runHandoffDispatch('codex', sampleInput(), deps);
    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.prompt).toBe(
      withSkillPointer("Let's work on `specs/foo/SPEC.md` using OpenKnowledge."),
    );
    expect(payload.prompt).not.toContain('Open the OK editor');
  });

  test('folder scope: prompt drops the "Open the OK editor in web view." trailer when autoOpen=false', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps({ autoOpen: false });
    const input: HandoffDispatchInput = {
      docContext: null,
      folderRelativePath: 'specs/notes',
      projectDir: '/Users/sarah/proj',
      docPath: '',
    };
    await runHandoffDispatch('codex', input, deps);
    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.prompt).toBe(
      withSkillPointer("Let's work on the `specs/notes` folder using OpenKnowledge."),
    );
    expect(payload.prompt).not.toContain('Open the OK editor');
  });

  test('empty-space scope: prompt drops the "Open the OK editor in web view." trailer when autoOpen=false', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps({ autoOpen: false });
    const input: HandoffDispatchInput = {
      docContext: null,
      projectDir: '/Users/sarah/proj',
      docPath: '',
    };
    await runHandoffDispatch('codex', input, deps);
    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.prompt).toBe(
      withSkillPointer("Let's work on this project using OpenKnowledge."),
    );
    expect(payload.prompt).not.toContain('Open the OK editor');
  });
});

describe('runHandoffDispatch — failure path', () => {
  test('renders error toast with Retry action and records error stats line', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps({
      dispatchHandoff: mock(
        async (_p: HandoffPayload) => ({ ok: false, reason: 'not-installed' }) as HandoffOutcome,
      ),
    });

    const outcome = await runHandoffDispatch('cursor', sampleInput(), deps);

    expect(outcome).toEqual({ ok: false, reason: 'not-installed' });
    expect(deps.toast.successCalls).toEqual([]);
    expect(deps.toast.errorCalls).toHaveLength(1);
    const errorCall = deps.toast.errorCalls[0];
    expect(errorCall).toBeDefined();
    if (!errorCall) throw new Error('unreachable'); // narrow for TS
    expect(errorCall.message).toBe("Couldn't reach Cursor — try again?");
    expect(errorCall.action?.label).toBe('Retry');
    expect(typeof errorCall.action?.onClick).toBe('function');

    expect(deps.recordHandoff).toHaveBeenCalledTimes(1);
    expect(deps.recordHandoff).toHaveBeenCalledWith({
      target: 'cursor',
      host: 'electron',
      outcome: 'error',
      ts: '2026-04-22T03:00:00.000Z',
      reason: 'not-installed',
    });
  });

  test('retry action re-invokes dispatchHandoff with the same payload', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const dispatch = mock(async (_p: HandoffPayload) => ({ ok: true }) as HandoffOutcome);
    // First call returns failure; subsequent retries return success.
    let firstCall = true;
    (
      dispatch as unknown as { mockImplementation: (fn: typeof dispatch) => void }
    ).mockImplementation?.((async (_p: HandoffPayload) => {
      if (firstCall) {
        firstCall = false;
        return { ok: false, reason: 'not-installed' } as HandoffOutcome;
      }
      return { ok: true } as HandoffOutcome;
    }) as typeof dispatch);

    const deps = buildDeps({ dispatchHandoff: dispatch });
    const input = sampleInput();

    const first = await runHandoffDispatch('cursor', input, deps);
    expect(first.ok).toBe(false);
    expect(deps.recordHandoff).toHaveBeenCalledTimes(1);

    // Invoke the retry onClick synchronously — it schedules a fresh dispatch.
    const action = deps.toast.errorCalls[0]?.action;
    expect(action).toBeDefined();
    action?.onClick();

    // The retry is fire-and-forget (`void runHandoffDispatch(...)`). Yield so
    // the second attempt's await-chain completes before assertions.
    await wait(0);

    expect(dispatch).toHaveBeenCalledTimes(2);
    const firstPayload = (dispatch as ReturnType<typeof mock>).mock.calls[0]?.[0] as HandoffPayload;
    const secondPayload = (dispatch as ReturnType<typeof mock>).mock
      .calls[1]?.[0] as HandoffPayload;
    expect(secondPayload).toEqual(firstPayload);

    // Retry's own telemetry line lands.
    expect(deps.recordHandoff).toHaveBeenCalledTimes(2);
    // Retry succeeded → a fresh success toast appears.
    expect(deps.toast.successCalls).toEqual(['Opened in Cursor.']);
  });

  test('third consecutive failure drops the Retry action (Review M5 bounded retry)', async () => {
    // The retry chain is capped at MAX_DISPATCH_ATTEMPTS (=3). First failure:
    // "Retry" button + "try again?" copy. Second failure: "Try one more time"
    // button + "Still couldn't reach" copy. Third failure: distinct
    // "please try again later" copy, NO button — user cannot loop further.
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const dispatch = mock(
      async (_p: HandoffPayload) => ({ ok: false, reason: 'dispatch-error' }) as HandoffOutcome,
    );
    const deps = buildDeps({ dispatchHandoff: dispatch });
    const input = sampleInput();

    // Attempt 1 — initial dispatch.
    await runHandoffDispatch('cursor', input, deps);
    expect(deps.toast.errorCalls).toHaveLength(1);
    expect(deps.toast.errorCalls[0]?.message).toBe("Couldn't reach Cursor — try again?");
    expect(deps.toast.errorCalls[0]?.action?.label).toBe('Retry');

    // Attempt 2 — click Retry.
    const firstAction = deps.toast.errorCalls[0]?.action;
    expect(firstAction).toBeDefined();
    firstAction?.onClick();
    await wait(0);
    expect(deps.toast.errorCalls).toHaveLength(2);
    expect(deps.toast.errorCalls[1]?.message).toBe(
      "Still couldn't reach Cursor — try one more time?",
    );
    expect(deps.toast.errorCalls[1]?.action?.label).toBe('Try one more time');

    // Attempt 3 — click Try one more time.
    const secondAction = deps.toast.errorCalls[1]?.action;
    expect(secondAction).toBeDefined();
    secondAction?.onClick();
    await wait(0);
    expect(deps.toast.errorCalls).toHaveLength(3);
    expect(deps.toast.errorCalls[2]?.message).toBe(
      "Couldn't reach Cursor — please try again later.",
    );
    // CAP ENFORCED — no Retry action on the final toast. The chain terminates
    // here; there is no button the user can click to fire a fourth attempt.
    expect(deps.toast.errorCalls[2]?.action).toBeUndefined();

    // Three attempts, three telemetry lines.
    expect(deps.recordHandoff).toHaveBeenCalledTimes(3);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  test('web-host-cursor-unsupported reason flows through to telemetry + toast', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps({
      dispatchHandoff: mock(
        async (_p: HandoffPayload) =>
          ({
            ok: false,
            reason: 'web-host-cursor-unsupported',
          }) as HandoffOutcome,
      ),
      isElectronHost: () => false,
    });

    await runHandoffDispatch('cursor', sampleInput(), deps);

    expect(deps.recordHandoff).toHaveBeenCalledWith({
      target: 'cursor',
      host: 'web',
      outcome: 'error',
      ts: '2026-04-22T03:00:00.000Z',
      reason: 'web-host-cursor-unsupported',
    });
    expect(deps.toast.errorCalls[0]?.message).toBe("Couldn't reach Cursor — try again?");
  });
});

describe('defaultHandoffDispatchDeps — production wiring', () => {
  test('returns a full deps object with every slot populated', async () => {
    const { defaultHandoffDispatchDeps } = await import('./useHandoffDispatch');
    const deps = defaultHandoffDispatchDeps();
    expect(typeof deps.dispatchHandoff).toBe('function');
    expect(typeof deps.recordHandoff).toBe('function');
    expect(typeof deps.toast.success).toBe('function');
    expect(typeof deps.toast.error).toBe('function');
    expect(deps.now()).toBeInstanceOf(Date);
    expect(typeof deps.isElectronHost()).toBe('boolean');
    expect(deps.getDisplayName('claude-cowork')).toBe('Claude Cowork');
    expect(typeof deps.ensureCoworkSkillInstalled).toBe('function');
    // The factory defaults autoOpen to true so non-hook callers preserve the
    // legacy "agent opens preview" behavior. The hook overrides this with the
    // live config value at dispatch time.
    expect(deps.autoOpen).toBe(true);
  });
});

describe('runHandoffDispatch — Cowork install gate', () => {
  test('first click + bridge ran: shows install toast and skips URL dispatch', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps({
      ensureCoworkSkillInstalled: mock(
        async () => ({ kind: 'installed-now', path: '/tmp/openknowledge.skill' }) as const,
      ),
    });

    const outcome = await runHandoffDispatch('claude-cowork', sampleInput(), deps);

    expect(outcome).toEqual({ ok: true });
    expect(deps.dispatchHandoff).not.toHaveBeenCalled();
    expect(deps.recordHandoff).not.toHaveBeenCalled();
    expect(deps.toast.successCalls).toEqual([
      'OpenKnowledge skill saved. Upload it in Claude Desktop, then click Cowork again.',
    ]);
  });

  test('install-failed: surfaces error toast and returns dispatch-error outcome', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps({
      ensureCoworkSkillInstalled: mock(
        async () =>
          ({
            kind: 'install-failed',
            reason: 'open-failed',
            message: 'Claude Desktop not found',
          }) as const,
      ),
    });

    const outcome = await runHandoffDispatch('claude-cowork', sampleInput(), deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('dispatch-error');
      expect(outcome.detail).toContain('install-failed');
    }
    expect(deps.dispatchHandoff).not.toHaveBeenCalled();
    expect(deps.toast.errorCalls[0]?.message).toBe(
      "Couldn't install OpenKnowledge skill — Claude Desktop not found",
    );
  });

  test('already-installed: falls through to URL dispatch (default test path)', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps(); // default ensureCoworkSkillInstalled → already-installed

    await runHandoffDispatch('claude-cowork', sampleInput(), deps);

    expect(deps.dispatchHandoff).toHaveBeenCalledTimes(1);
    expect(deps.toast.successCalls).toEqual(['Opened in Claude Cowork.']);
  });

  test('host-unsupported (web): falls through to URL dispatch unchanged', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps({
      isElectronHost: () => false,
      ensureCoworkSkillInstalled: mock(async () => ({ kind: 'host-unsupported' }) as const),
    });

    await runHandoffDispatch('claude-cowork', sampleInput(), deps);

    expect(deps.dispatchHandoff).toHaveBeenCalledTimes(1);
    expect(deps.toast.successCalls).toEqual(['Opened in Claude Cowork.']);
  });

  test('non-Cowork target: install gate is never consulted', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const ensureSpy = mock(async () => ({ kind: 'already-installed' }) as const);
    const deps = buildDeps({ ensureCoworkSkillInstalled: ensureSpy });

    await runHandoffDispatch('codex', sampleInput(), deps);
    await runHandoffDispatch('claude-code', sampleInput(), deps);
    await runHandoffDispatch('cursor', sampleInput(), deps);

    expect(ensureSpy).not.toHaveBeenCalled();
  });

  test('retry attempt skips the install gate (only first attempt invokes it)', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const ensureSpy = mock(async () => ({ kind: 'already-installed' }) as const);
    const deps = buildDeps({ ensureCoworkSkillInstalled: ensureSpy });

    // attempt=2 simulates a retry — the install gate must not re-run.
    await runHandoffDispatch('claude-cowork', sampleInput(), deps, 2);

    expect(ensureSpy).not.toHaveBeenCalled();
    expect(deps.dispatchHandoff).toHaveBeenCalledTimes(1);
  });

  test('install gate throws: surfaces error toast + dispatch-error outcome (no unhandled rejection)', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps({
      ensureCoworkSkillInstalled: mock(async () => {
        throw new Error('IPC channel closed');
      }),
    });

    const outcome = await runHandoffDispatch('claude-cowork', sampleInput(), deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('dispatch-error');
      expect(outcome.detail).toContain('install-error');
      expect(outcome.detail).toContain('IPC channel closed');
    }
    expect(deps.dispatchHandoff).not.toHaveBeenCalled();
    expect(deps.toast.errorCalls[0]?.message).toBe(
      "Couldn't install OpenKnowledge skill — IPC channel closed",
    );
  });
});

describe('buildHandoffInput — shared surface helper (US-011)', () => {
  test('null docName returns null', async () => {
    const { buildHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildHandoffInput({
        docName: null,
        workspace: { contentDir: '/repo', pathSeparator: '/' },
      }),
    ).toBeNull();
  });

  test('null workspace returns null', async () => {
    const { buildHandoffInput } = await import('./useHandoffDispatch');
    expect(buildHandoffInput({ docName: 'specs/foo/SPEC', workspace: null })).toBeNull();
  });

  test('POSIX: composes relativePath + projectDir + docPath', async () => {
    const { buildHandoffInput } = await import('./useHandoffDispatch');
    const input = buildHandoffInput({
      docName: 'specs/foo/SPEC',
      workspace: { contentDir: '/Users/andrew/repo', pathSeparator: '/' },
    });
    expect(input).toEqual({
      docContext: { relativePath: 'specs/foo/SPEC.md' },
      projectDir: '/Users/andrew/repo',
      docPath: '/Users/andrew/repo/specs/foo/SPEC.md',
    });
  });

  test('Windows: rewrites relativePath slashes to backslash for docPath', async () => {
    const { buildHandoffInput } = await import('./useHandoffDispatch');
    const input = buildHandoffInput({
      docName: 'specs/foo/SPEC',
      workspace: { contentDir: 'C:\\repo', pathSeparator: '\\' },
    });
    // `docContext.relativePath` stays POSIX-form (matches the content-directory
    // convention + the MCP `read_document` contract). Only `docPath` uses
    // backslashes because that's the raw OS-native path the target agent's
    // URL scheme expects for `file=`/`path=`.
    expect(input?.docContext.relativePath).toBe('specs/foo/SPEC.md');
    expect(input?.projectDir).toBe('C:\\repo');
    expect(input?.docPath).toBe('C:\\repo\\specs\\foo\\SPEC.md');
  });

  test('empty-string docName is treated as no active doc (null return)', async () => {
    // The `!args.docName` guard covers empty-string as well as null. Surfaces
    // sometimes carry an empty-string sentinel before the hash resolves.
    const { buildHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildHandoffInput({
        docName: '',
        workspace: { contentDir: '/repo', pathSeparator: '/' },
      }),
    ).toBeNull();
  });
});

describe('buildSkillHandoffInput + selectScopedPrompt — skill scope (author-with-AI)', () => {
  test('null workspace or empty name returns null', async () => {
    const { buildSkillHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildSkillHandoffInput({ skillName: 'x', scope: 'project', workspace: null }),
    ).toBeNull();
    expect(
      buildSkillHandoffInput({
        skillName: '',
        scope: 'project',
        workspace: { contentDir: '/repo', pathSeparator: '/' },
      }),
    ).toBeNull();
  });

  test('carries the skill name + scope; no doc path (agent reaches it via OK MCP)', async () => {
    const { buildSkillHandoffInput } = await import('./useHandoffDispatch');
    const input = buildSkillHandoffInput({
      skillName: 'commit-helper',
      scope: 'global',
      workspace: { contentDir: '/Users/sarah/proj', pathSeparator: '/' },
    });
    expect(input).toEqual({
      docContext: null,
      skill: { name: 'commit-helper', scope: 'global' },
      projectDir: '/Users/sarah/proj',
      docPath: '',
    });
  });

  test('selectScopedPrompt routes a skill input to composeSkillPrompt', async () => {
    const { buildSkillHandoffInput, selectScopedPrompt } = await import('./useHandoffDispatch');
    const input = buildSkillHandoffInput({
      skillName: 'commit-helper',
      scope: 'project',
      workspace: { contentDir: '/repo', pathSeparator: '/' },
    });
    if (!input) throw new Error('expected a non-null skill input');
    expect(selectScopedPrompt(input, 'claude-code', true)).toBe(
      'Use your open-knowledge-write-skill skill to author the project Open Knowledge skill `commit-helper`. Edit it with the Open Knowledge tools. Open the OK editor in web view.',
    );
  });
});

describe('buildProjectScopedHandoffInput — empty-state cards helper', () => {
  test('null workspace returns null (cards render disabled while resolving)', async () => {
    const { buildProjectScopedHandoffInput } = await import('./useHandoffDispatch');
    expect(buildProjectScopedHandoffInput({ workspace: null })).toBeNull();
  });

  test('returns docContext: null + empty docPath + projectDir from workspace', async () => {
    const { buildProjectScopedHandoffInput } = await import('./useHandoffDispatch');
    const input = buildProjectScopedHandoffInput({
      workspace: { contentDir: '/Users/sarah/proj', pathSeparator: '/' },
    });
    // Project-scoped handoff: empty docPath and null docContext flow through
    // runHandoffDispatch, which composes the empty-space directive
    // so the target editor opens prefilled. URL builders still drop the
    // `file=` param because docPath is empty.
    expect(input).toEqual({
      docContext: null,
      projectDir: '/Users/sarah/proj',
      docPath: '',
    });
  });

  test('Windows: projectDir carries native backslash path verbatim', async () => {
    const { buildProjectScopedHandoffInput } = await import('./useHandoffDispatch');
    const input = buildProjectScopedHandoffInput({
      workspace: { contentDir: 'C:\\Users\\sarah\\proj', pathSeparator: '\\' },
    });
    expect(input?.projectDir).toBe('C:\\Users\\sarah\\proj');
    expect(input?.docPath).toBe('');
    expect(input?.docContext).toBeNull();
  });
});

describe('buildCreateHandoffInput — empty-state create-composer helper', () => {
  test('null workspace returns null (composer dispatches disabled while resolving)', async () => {
    const { buildCreateHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildCreateHandoffInput({
        workspace: null,
        description: 'a wiki',
        scenario: 'new-project',
        mentions: [],
      }),
    ).toBeNull();
  });

  test('empty workspace.contentDir returns null (same falsy guard as siblings)', async () => {
    const { buildCreateHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildCreateHandoffInput({
        workspace: { contentDir: '', pathSeparator: '/' },
        description: 'a wiki',
        scenario: 'new-project',
        mentions: [],
      }),
    ).toBeNull();
  });

  test('carries the brief + scenario + mentions on the create-scope shape (docContext null, empty docPath)', async () => {
    const { buildCreateHandoffInput } = await import('./useHandoffDispatch');
    const input = buildCreateHandoffInput({
      workspace: { contentDir: '/Users/sarah/proj', pathSeparator: '/' },
      description: 'a research knowledge base',
      scenario: 'existing-repo',
      mentions: ['notes/a.md', 'glossary.md'],
    });
    expect(input).toEqual({
      docContext: null,
      createDescription: 'a research knowledge base',
      createScenario: 'existing-repo',
      createMentions: ['notes/a.md', 'glossary.md'],
      projectDir: '/Users/sarah/proj',
      docPath: '',
    });
  });

  test('empty description is preserved verbatim (composer degrades it, not the builder)', async () => {
    // The builder passes the raw textarea value through; trimming + the
    // bare-directive fallback live in composeCreatePrompt. An empty string is a
    // valid input that still routes to the create scope.
    const { buildCreateHandoffInput } = await import('./useHandoffDispatch');
    const input = buildCreateHandoffInput({
      workspace: { contentDir: '/Users/sarah/proj', pathSeparator: '/' },
      description: '',
      scenario: 'new-project',
      mentions: [],
    });
    expect(input?.createDescription).toBe('');
  });
});

describe('buildFolderHandoffInput — folder-scoped helper (D23 / FR4 / FR14)', () => {
  test('null workspace returns null (submenu renders disabled while resolving)', async () => {
    const { buildFolderHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildFolderHandoffInput({
        folderRelativePath: 'notes',
        workspace: null,
      }),
    ).toBeNull();
  });

  test('empty folderRelativePath returns null (renderer-bug short-circuit)', async () => {
    // If the caller can't derive a tree-item-relative path, short-circuit
    // before the dispatch hook would try to compose composeFolderPrompt('').
    const { buildFolderHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildFolderHandoffInput({
        folderRelativePath: '',
        workspace: { contentDir: '/Users/sarah/proj', pathSeparator: '/' },
      }),
    ).toBeNull();
  });

  test('empty workspace.contentDir returns null (total-function ergonomics)', async () => {
    // The `!args.workspace?.contentDir` guard covers an empty-string
    // contentDir as well as null (falsy check, not nullish check). Workspace
    // resolution produces a real path or null in practice, but pinning the
    // guard keeps the helper total — callers don't have to branch on
    // truthy-contentDir before the call.
    const { buildFolderHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildFolderHandoffInput({
        folderRelativePath: 'notes',
        workspace: { contentDir: '', pathSeparator: '/' },
      }),
    ).toBeNull();
  });

  test('POSIX: returns docContext: null + folderRelativePath + contentDir as projectDir', async () => {
    const { buildFolderHandoffInput } = await import('./useHandoffDispatch');
    const input = buildFolderHandoffInput({
      folderRelativePath: 'specs/foo',
      workspace: { contentDir: '/Users/sarah/proj', pathSeparator: '/' },
    });
    // Folder-scoped handoff: docContext null + folderRelativePath set
    // + empty docPath. The dispatch hook picks composeFolderPrompt; the
    // per-agent URL builders treat `projectDir` as cwd. Folder scope keeps
    // cwd at contentDir so project-level agent tooling (`.claude/launch.json`,
    // `AGENTS.md`, `.codex/`, MCP settings) resolves — folder focus is
    // conveyed via the directive prompt, not cwd.
    expect(input).toEqual({
      docContext: null,
      folderRelativePath: 'specs/foo',
      projectDir: '/Users/sarah/proj',
      docPath: '',
    });
  });

  test('Windows: projectDir carries contentDir backslash path verbatim; folderRelativePath stays POSIX', async () => {
    const { buildFolderHandoffInput } = await import('./useHandoffDispatch');
    const input = buildFolderHandoffInput({
      // The relative form stays POSIX (same convention as docContext.relativePath
      // — see `buildHandoffInput` Windows test). The OS-native projection lives
      // in `workspace.contentDir` and flows through `projectDir`.
      folderRelativePath: 'specs/foo',
      workspace: { contentDir: 'C:\\Users\\sarah\\proj', pathSeparator: '\\' },
    });
    expect(input?.projectDir).toBe('C:\\Users\\sarah\\proj');
    expect(input?.folderRelativePath).toBe('specs/foo');
    expect(input?.docPath).toBe('');
    expect(input?.docContext).toBeNull();
  });

  test('sibling shape parity with buildProjectScopedHandoffInput: same field set + same projectDir', async () => {
    // The two helpers BOTH set docContext: null + docPath: '' but folder-
    // scope carries `folderRelativePath` as the discriminator;
    // project-scope omits it. Both share `projectDir: workspace.contentDir` —
    // folder focus is conveyed via the directive prompt, not via cwd.
    const { buildFolderHandoffInput, buildProjectScopedHandoffInput } = await import(
      './useHandoffDispatch'
    );
    const workspace = { contentDir: '/Users/sarah/proj', pathSeparator: '/' as const };
    const project = buildProjectScopedHandoffInput({ workspace });
    const folder = buildFolderHandoffInput({
      folderRelativePath: 'notes',
      workspace,
    });
    expect(project?.docContext).toBeNull();
    expect(folder?.docContext).toBeNull();
    expect(project?.docPath).toBe('');
    expect(folder?.docPath).toBe('');
    // Project-scope omits folderRelativePath (discriminator selects empty-
    // space template); folder-scope carries it (selects folder template).
    expect(project?.folderRelativePath).toBeUndefined();
    expect(folder?.folderRelativePath).toBe('notes');
    // Both scopes share contentDir as projectDir — folder focus rides on the
    // prompt template, not on cwd.
    expect(project?.projectDir).toBe('/Users/sarah/proj');
    expect(folder?.projectDir).toBe('/Users/sarah/proj');
  });
});

describe('selectScopedPrompt — template selection across autoOpen modes', () => {
  test('file scope (docContext set) returns composeFilePrompt(relativePath, autoOpen=true)', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeFilePrompt } = await import('@inkeep/open-knowledge-core');
    const out = selectScopedPrompt(
      {
        docContext: { relativePath: 'notes/today.md' },
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
      },
      'claude-code',
      true,
    );
    expect(out).toBe(withSkillPointer(composeFilePrompt('notes/today.md', true)));
    expect(out).toBe(
      withSkillPointer(
        "Let's work on `notes/today.md` using OpenKnowledge. Open the OK editor in web view.",
      ),
    );
  });

  test('file scope (docContext set) drops the trailer when autoOpen=false', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const out = selectScopedPrompt(
      {
        docContext: { relativePath: 'notes/today.md' },
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
      },
      'claude-code',
      false,
    );
    expect(out).toBe(withSkillPointer("Let's work on `notes/today.md` using OpenKnowledge."));
  });

  test('folder scope (docContext null + folderRelativePath set) returns composeFolderPrompt with autoOpen=true trailer', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeFolderPrompt } = await import('@inkeep/open-knowledge-core');
    const out = selectScopedPrompt(
      {
        docContext: null,
        folderRelativePath: 'notes',
        projectDir: '/proj',
        docPath: '',
      },
      'claude-code',
      true,
    );
    expect(out).toBe(withSkillPointer(composeFolderPrompt('notes', true)));
    expect(out).toBe(
      withSkillPointer(
        "Let's work on the `notes` folder using OpenKnowledge. Open the OK editor in web view.",
      ),
    );
  });

  test('folder scope drops the trailer when autoOpen=false', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const out = selectScopedPrompt(
      {
        docContext: null,
        folderRelativePath: 'notes',
        projectDir: '/proj',
        docPath: '',
      },
      'claude-code',
      false,
    );
    expect(out).toBe(withSkillPointer("Let's work on the `notes` folder using OpenKnowledge."));
  });

  test('empty-space scope (both null/absent) returns composeEmptySpacePrompt(autoOpen=true)', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeEmptySpacePrompt } = await import('@inkeep/open-knowledge-core');
    const out = selectScopedPrompt(
      {
        docContext: null,
        projectDir: '/proj',
        docPath: '',
      },
      'claude-code',
      true,
    );
    expect(out).toBe(withSkillPointer(composeEmptySpacePrompt(true)));
    expect(out).toBe(
      withSkillPointer(
        "Let's work on this project using OpenKnowledge. Open the OK editor in web view.",
      ),
    );
  });

  test('empty-space scope drops the trailer when autoOpen=false', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const out = selectScopedPrompt(
      {
        docContext: null,
        projectDir: '/proj',
        docPath: '',
      },
      'claude-code',
      false,
    );
    expect(out).toBe(withSkillPointer("Let's work on this project using OpenKnowledge."));
  });

  test('file scope threads the toolbar instruction into the directive prompt', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeFilePrompt } = await import('@inkeep/open-knowledge-core');
    const out = selectScopedPrompt(
      {
        docContext: { relativePath: 'notes/today.md' },
        instruction: 'Tighten the intro',
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
      },
      'claude-code',
      true,
    );
    expect(out).toBe(
      withSkillPointer(composeFilePrompt('notes/today.md', true, 'Tighten the intro')),
    );
    expect(out).toContain('Instruction:\n\n> Tighten the intro');
  });

  test('folder scope threads the toolbar instruction', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const out = selectScopedPrompt(
      {
        docContext: null,
        folderRelativePath: 'notes',
        instruction: 'Review the structure',
        projectDir: '/proj',
        docPath: '',
      },
      'claude-code',
      true,
    );
    expect(out).toContain("Let's work on the `notes` folder using OpenKnowledge.");
    expect(out).toContain('> Review the structure');
  });

  test('empty-space scope threads the toolbar instruction', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const out = selectScopedPrompt(
      {
        docContext: null,
        instruction: 'Scaffold the wiki',
        projectDir: '/proj',
        docPath: '',
      },
      'claude-code',
      true,
    );
    expect(out).toContain("Let's work on this project using OpenKnowledge.");
    expect(out).toContain('> Scaffold the wiki');
  });

  test('selection scope ignores the top-level instruction — selection.instruction wins', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const out = selectScopedPrompt(
      {
        docContext: null,
        instruction: 'top-level directive instruction',
        selection: {
          relativePath: 'notes/today.md',
          instruction: 'selection instruction',
          selectionMarkdown: 'the passage',
        },
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
      },
      'claude-code',
      true,
    );
    expect(out).toContain('> selection instruction');
    expect(out).not.toContain('top-level directive instruction');
  });

  test('create scope ignores the top-level instruction — createDescription is the only free-text', async () => {
    // Symmetric to the selection-scope precedence test: when a caller
    // hand-sets both the toolbar `instruction` and `createDescription`, the
    // create branch of `selectScopedPrompt` wins and the top-level instruction
    // is dropped (the directive composers it would feed are never reached).
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const out = selectScopedPrompt(
      {
        docContext: null,
        instruction: 'top-level directive instruction',
        createDescription: 'a worldbuilding wiki',
        createScenario: 'new-project',
        projectDir: '/proj',
        docPath: '',
      },
      'claude-code',
      true,
    );
    expect(out).toContain('> a worldbuilding wiki');
    expect(out).not.toContain('top-level directive instruction');
  });

  test('file scope threads the instruction even when autoOpen=false (trailer dropped, instruction kept)', async () => {
    // All other instruction-threading tests use autoOpen=true; pin that the
    // autoOpen=false branch still forwards the instruction to the composer
    // rather than dropping it alongside the "Open the OK editor" trailer.
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const out = selectScopedPrompt(
      {
        docContext: { relativePath: 'notes/today.md' },
        instruction: 'Fix the intro',
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
      },
      'claude-code',
      false,
    );
    expect(out).toContain('> Fix the intro');
    expect(out).not.toContain('Open the OK editor');
  });

  test('create scope (createDescription set) returns composeCreatePrompt with the scenario', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeCreatePrompt } = await import('@inkeep/open-knowledge-core');
    const out = selectScopedPrompt(
      {
        docContext: null,
        createDescription: 'a worldbuilding wiki',
        createScenario: 'new-project',
        projectDir: '/proj',
        docPath: '',
      },
      'claude-code',
      true,
    );
    expect(out).toBe(
      withSkillPointer(composeCreatePrompt('a worldbuilding wiki', true, 'new-project', [])),
    );
    expect(out).toContain('> a worldbuilding wiki');
    expect(out).toContain('Open the OK editor in web view.');
  });

  test('create scope threads createMentions into composeCreatePrompt', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeCreatePrompt } = await import('@inkeep/open-knowledge-core');
    const out = selectScopedPrompt(
      {
        docContext: null,
        createDescription: 'a worldbuilding wiki',
        createScenario: 'new-project',
        createMentions: ['notes/lore.md', 'maps/world.md'],
        projectDir: '/proj',
        docPath: '',
      },
      'claude-code',
      false,
    );
    expect(out).toBe(
      withSkillPointer(
        composeCreatePrompt('a worldbuilding wiki', false, 'new-project', [
          'notes/lore.md',
          'maps/world.md',
        ]),
      ),
    );
    expect(out).toContain('Also reference:\n\n@notes/lore.md\n@maps/world.md');
  });

  test('create scope threads existing-repo — no "new project" framing', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const out = selectScopedPrompt(
      {
        docContext: null,
        createDescription: 'draft a spec for this codebase',
        createScenario: 'existing-repo',
        projectDir: '/proj',
        docPath: '',
      },
      'claude-code',
      true,
    );
    expect(out).not.toContain('new OpenKnowledge project');
    expect(out).toContain('> draft a spec for this codebase');
  });

  test('create scope defaults to new-project when createScenario is absent', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeCreatePrompt } = await import('@inkeep/open-knowledge-core');
    const out = selectScopedPrompt(
      { docContext: null, createDescription: 'a wiki', projectDir: '/proj', docPath: '' },
      'claude-code',
      false,
    );
    expect(out).toBe(withSkillPointer(composeCreatePrompt('a wiki', false, 'new-project', [])));
  });

  test('create scope with empty createDescription routes to the create composer, NOT empty-space', async () => {
    // `createDescription: ''` is distinct from absent: an empty string still
    // selects the create scope (the field is set), so the prompt is the create
    // composer's bare-directive fallback rather than the empty-space directive.
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeCreatePrompt, composeEmptySpacePrompt } = await import(
      '@inkeep/open-knowledge-core'
    );
    const out = selectScopedPrompt(
      {
        docContext: null,
        createDescription: '',
        createScenario: 'new-project',
        projectDir: '/proj',
        docPath: '',
      },
      'claude-code',
      true,
    );
    expect(out).toBe(withSkillPointer(composeCreatePrompt('', true, 'new-project', [])));
    expect(out).not.toBe(withSkillPointer(composeEmptySpacePrompt(true)));
  });

  test('precedence: docContext beats folderRelativePath when both are set (defensive ordering)', async () => {
    // Production helpers never construct an input with both fields — the
    // helpers are mutually exclusive at the boundary. But if a future
    // hand-constructed caller passes both, the dispatch picks file scope
    // (more specific). The two helpers guarantee mutual exclusion in
    // practice; this test pins the defensive ordering so a future refactor
    // that reorders the if-chain doesn't silently demote file scope.
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeFilePrompt } = await import('@inkeep/open-knowledge-core');
    const out = selectScopedPrompt(
      {
        docContext: { relativePath: 'a.md' },
        folderRelativePath: 'folder',
        projectDir: '/proj',
        docPath: '/proj/a.md',
      },
      'claude-code',
      true,
    );
    expect(out).toBe(withSkillPointer(composeFilePrompt('a.md', true)));
  });

  test('selection scope (selection set) returns composeSelectionPrompt for the target', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeSelectionPrompt } = await import('@inkeep/open-knowledge-core');
    const selection = {
      relativePath: 'notes/today.md',
      instruction: 'tighten this',
      selectionMarkdown: 'A wordy sentence that could be shorter.',
    };
    const out = selectScopedPrompt(
      {
        docContext: null,
        selection,
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
      },
      'cursor',
      true,
    );
    expect(out).toBe(composeSelectionPrompt({ ...selection, target: 'cursor' }));
  });

  test('the standing skill pointer rides every directive scope but NOT selection', async () => {
    // OK-launched agents are steered to the project skill on the first turn
    // (file / folder / create / empty-space). Selection is excluded — it already
    // ends with an explicit "read via OK MCP" directive and is the most
    // URL-budget-constrained prompt.
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { OK_PROJECT_SKILL_POINTER } = await import('@inkeep/open-knowledge-core');
    const base = { projectDir: '/proj', docPath: '' } as const;

    const file = selectScopedPrompt(
      { ...base, docContext: { relativePath: 'a.md' }, docPath: '/proj/a.md' },
      'claude-code',
      true,
    );
    const folder = selectScopedPrompt(
      { ...base, docContext: null, folderRelativePath: 'specs' },
      'claude-code',
      true,
    );
    const empty = selectScopedPrompt({ ...base, docContext: null }, 'claude-code', true);
    const create = selectScopedPrompt(
      { ...base, docContext: null, createDescription: 'a wiki' },
      'claude-code',
      true,
    );
    const selection = selectScopedPrompt(
      {
        ...base,
        docContext: null,
        selection: { relativePath: 'a.md', instruction: 'x', selectionMarkdown: 'y' },
      },
      'claude-code',
      true,
    );

    for (const prompt of [file, folder, empty, create]) {
      expect(prompt.startsWith(OK_PROJECT_SKILL_POINTER)).toBe(true);
    }
    expect(selection).not.toContain(OK_PROJECT_SKILL_POINTER);
  });

  test('precedence: selection beats docContext when both are set (defensive ordering)', async () => {
    // Production helpers never set both — buildSelectionHandoffInput sets
    // docContext null. The defensive ordering pins selection as the most
    // specific scope so a future if-chain reorder cannot silently demote it.
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeSelectionPrompt } = await import('@inkeep/open-knowledge-core');
    const selection = {
      relativePath: 'a.md',
      instruction: '',
      selectionMarkdown: 'passage',
    };
    const out = selectScopedPrompt(
      {
        docContext: { relativePath: 'a.md' },
        selection,
        projectDir: '/proj',
        docPath: '/proj/a.md',
      },
      'claude-code',
      true,
    );
    expect(out).toBe(composeSelectionPrompt({ ...selection, target: 'claude-code' }));
  });
});

describe('buildSelectionHandoffInput — selection-scoped helper', () => {
  test('null docName returns null', async () => {
    const { buildSelectionHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildSelectionHandoffInput({
        docName: null,
        workspace: { contentDir: '/repo', pathSeparator: '/' },
        instruction: 'rewrite',
        selectionMarkdown: 'passage',
      }),
    ).toBeNull();
  });

  test('null workspace returns null', async () => {
    const { buildSelectionHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildSelectionHandoffInput({
        docName: 'notes/today',
        workspace: null,
        instruction: 'rewrite',
        selectionMarkdown: 'passage',
      }),
    ).toBeNull();
  });

  test('empty selectionMarkdown returns null (renderer-bug short-circuit)', async () => {
    // The affordance is render-gated on a non-empty selection upstream, so an
    // empty serialized selection reaching this helper is a renderer bug.
    const { buildSelectionHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildSelectionHandoffInput({
        docName: 'notes/today',
        workspace: { contentDir: '/repo', pathSeparator: '/' },
        instruction: 'rewrite',
        selectionMarkdown: '',
      }),
    ).toBeNull();
  });

  test('POSIX: composes the selection payload + projectDir + absolute docPath', async () => {
    const { buildSelectionHandoffInput } = await import('./useHandoffDispatch');
    const input = buildSelectionHandoffInput({
      docName: 'specs/foo/SPEC',
      workspace: { contentDir: '/Users/andrew/repo', pathSeparator: '/' },
      instruction: 'rewrite this passage',
      selectionMarkdown: 'The selected passage.',
    });
    expect(input).toEqual({
      docContext: null,
      selection: {
        relativePath: 'specs/foo/SPEC.md',
        instruction: 'rewrite this passage',
        selectionMarkdown: 'The selected passage.',
      },
      projectDir: '/Users/andrew/repo',
      docPath: '/Users/andrew/repo/specs/foo/SPEC.md',
    });
  });

  test('Windows: docPath uses backslashes; selection.relativePath stays POSIX', async () => {
    const { buildSelectionHandoffInput } = await import('./useHandoffDispatch');
    const input = buildSelectionHandoffInput({
      docName: 'specs/foo/SPEC',
      workspace: { contentDir: 'C:\\repo', pathSeparator: '\\' },
      instruction: '',
      selectionMarkdown: 'passage',
    });
    // relativePath stays POSIX (matches docContext.relativePath + the MCP
    // read_document contract); only docPath uses the OS-native separator.
    expect(input?.selection?.relativePath).toBe('specs/foo/SPEC.md');
    expect(input?.projectDir).toBe('C:\\repo');
    expect(input?.docPath).toBe('C:\\repo\\specs\\foo\\SPEC.md');
  });

  test('empty instruction is allowed — passes through, not a null trigger', async () => {
    const { buildSelectionHandoffInput } = await import('./useHandoffDispatch');
    const input = buildSelectionHandoffInput({
      docName: 'd',
      workspace: { contentDir: '/repo', pathSeparator: '/' },
      instruction: '',
      selectionMarkdown: 'passage',
    });
    expect(input).not.toBeNull();
    expect(input?.selection?.instruction).toBe('');
  });
});

describe('buildSelectionOrDocHandoffInput — selection/file fallback helper', () => {
  test('prefers selection scope when the serialized selection is non-empty', async () => {
    const { buildSelectionOrDocHandoffInput } = await import('./useHandoffDispatch');
    const input = buildSelectionOrDocHandoffInput({
      docName: 'specs/foo/SPEC',
      workspace: { contentDir: '/repo', pathSeparator: '/' },
      instruction: 'rewrite',
      selectionMarkdown: 'selected passage',
    });

    expect(input?.docContext).toBeNull();
    expect(input?.selection).toEqual({
      relativePath: 'specs/foo/SPEC.md',
      instruction: 'rewrite',
      selectionMarkdown: 'selected passage',
    });
    expect(input?.docPath).toBe('/repo/specs/foo/SPEC.md');
  });

  test('falls back to file scope when the serialized selection is empty', async () => {
    const { buildSelectionOrDocHandoffInput } = await import('./useHandoffDispatch');
    const input = buildSelectionOrDocHandoffInput({
      docName: 'specs/foo/SPEC',
      workspace: { contentDir: '/repo', pathSeparator: '/' },
      instruction: 'rewrite',
      selectionMarkdown: '',
    });

    expect(input).toEqual({
      docContext: { relativePath: 'specs/foo/SPEC.md' },
      projectDir: '/repo',
      docPath: '/repo/specs/foo/SPEC.md',
    });
  });

  test('returns null when neither selection nor file scope can be built', async () => {
    const { buildSelectionOrDocHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildSelectionOrDocHandoffInput({
        docName: null,
        workspace: { contentDir: '/repo', pathSeparator: '/' },
        instruction: 'rewrite',
        selectionMarkdown: '',
      }),
    ).toBeNull();
  });
});

describe('runHandoffDispatch — selection scope', () => {
  function selectionInput(): HandoffDispatchInput {
    return {
      docContext: null,
      selection: {
        relativePath: 'guides/style.md',
        instruction: 'make this concise',
        selectionMarkdown: 'This sentence is wordy.',
      },
      projectDir: '/tmp/proj',
      docPath: '/tmp/proj/guides/style.md',
    };
  }

  test('composes the selection prompt and dispatches it to the picked target', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const { composeSelectionPrompt } = await import('@inkeep/open-knowledge-core');
    const deps = buildDeps();

    await runHandoffDispatch('claude-code', selectionInput(), deps);

    expect(deps.dispatchHandoff).toHaveBeenCalledTimes(1);
    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.target).toBe('claude-code');
    expect(payload.projectDir).toBe('/tmp/proj');
    expect(payload.docPath).toBe('/tmp/proj/guides/style.md');
    expect(payload.prompt).toBe(
      composeSelectionPrompt({
        relativePath: 'guides/style.md',
        instruction: 'make this concise',
        selectionMarkdown: 'This sentence is wordy.',
        target: 'claude-code',
      }),
    );
  });

  test('records the selection scope on the telemetry line (Electron host)', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps();

    await runHandoffDispatch('codex', selectionInput(), deps);

    expect(deps.recordHandoff).toHaveBeenCalledTimes(1);
    expect(deps.recordHandoff).toHaveBeenCalledWith({
      target: 'codex',
      host: 'electron',
      outcome: 'ok',
      ts: '2026-04-22T03:00:00.000Z',
      scope: 'selection',
    });
  });

  test('selection dispatch on a web host builds a web-tagged line carrying the scope', async () => {
    // The recording double stands in for the IPC bridge. Production
    // `recordHandoff` no-ops on a web host (covered in telemetry.test.ts);
    // the scope tag rides on the line independent of host.
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps({ isElectronHost: () => false });

    await runHandoffDispatch('codex', selectionInput(), deps);

    expect(deps.recordHandoff).toHaveBeenCalledWith({
      target: 'codex',
      host: 'web',
      outcome: 'ok',
      ts: '2026-04-22T03:00:00.000Z',
      scope: 'selection',
    });
  });
});

describe('composeTerminalLaunchPrompt — docked-terminal bare launch is load + read + stop', () => {
  test('file scope reads the open file via OK MCP, then stops', async () => {
    const { composeTerminalLaunchPrompt } = await import('./useHandoffDispatch');
    const out = composeTerminalLaunchPrompt(
      {
        docContext: { relativePath: 'notes/today.md' },
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
      },
      'claude',
    );
    expect(out).toBe(composeTerminalBareLaunchPrompt('notes/today.md'));
    expect(out).toContain(OK_TERMINAL_SURFACE_PREAMBLE);
    expect(out).toContain('Read `notes/today.md` via the OpenKnowledge MCP server, then stop.');
    // No open-ended "Let's work on" invitation and no preview trailer.
    expect(out).not.toContain("Let's work on");
    expect(out).not.toContain('Open the OK editor');
  });

  test('folder scope has no file to read — just load and stop', async () => {
    const { composeTerminalLaunchPrompt } = await import('./useHandoffDispatch');
    const out = composeTerminalLaunchPrompt(
      {
        docContext: null,
        folderRelativePath: 'specs/foo',
        projectDir: '/proj',
        docPath: '',
      },
      'claude',
    );
    expect(out).toBe(composeTerminalBareLaunchPrompt(null));
    expect(out).toContain(OK_TERMINAL_SURFACE_PREAMBLE);
    expect(out.endsWith('Then stop.')).toBe(true);
    expect(out).not.toContain('Read `');
    expect(out).not.toContain("Let's work on");
  });

  test('project / empty-space scope — just load and stop', async () => {
    const { composeTerminalLaunchPrompt } = await import('./useHandoffDispatch');
    const out = composeTerminalLaunchPrompt(
      {
        docContext: null,
        projectDir: '/proj',
        docPath: '',
      },
      'claude',
    );
    expect(out).toBe(composeTerminalBareLaunchPrompt(null));
    expect(out.endsWith('Then stop.')).toBe(true);
    expect(out).not.toContain("Let's work on");
  });

  test('bare launch is CLI-agnostic — codex / cursor compose the same prompt as claude', async () => {
    // The load + read + stop wording carries no per-target encoding, so all
    // three CLIs get byte-identical bare prompts.
    const { composeTerminalLaunchPrompt } = await import('./useHandoffDispatch');
    const input = {
      docContext: { relativePath: 'notes/today.md' },
      projectDir: '/proj',
      docPath: '/proj/notes/today.md',
    };
    const claudeOut = composeTerminalLaunchPrompt(input, 'claude');
    expect(claudeOut).toBe(composeTerminalBareLaunchPrompt('notes/today.md'));
    expect(composeTerminalLaunchPrompt(input, 'codex')).toBe(claudeOut);
    expect(composeTerminalLaunchPrompt(input, 'cursor')).toBe(claudeOut);
  });

  test('typed instruction is preserved per CLI, led by the terminal-surface preamble', async () => {
    // An explicit instruction is real user intent — the bare load+read+stop
    // form would discard it, so instruction-bearing launches keep the directive
    // composer, composed against the CLI's own handoff target. The terminal-
    // surface preamble leads so the launch still establishes the OK handoff
    // context before the user's ask (context first, then the typed instruction).
    const { composeTerminalLaunchPrompt, selectScopedPrompt } = await import(
      './useHandoffDispatch'
    );
    const input = {
      docContext: { relativePath: 'notes/today.md' },
      projectDir: '/proj',
      docPath: '/proj/notes/today.md',
      instruction: 'summarize the open questions',
    };
    expect(composeTerminalLaunchPrompt(input, 'claude')).toBe(
      `${OK_TERMINAL_SURFACE_PREAMBLE} ${selectScopedPrompt(input, 'claude-code', false)}`,
    );
    expect(composeTerminalLaunchPrompt(input, 'codex')).toBe(
      `${OK_TERMINAL_SURFACE_PREAMBLE} ${selectScopedPrompt(input, 'codex', false)}`,
    );
    // Cursor has a distinct handoffTarget ('cursor') + double-encoding; pin it
    // so a regression in the TERMINAL_CLIS['cursor'] mapping is caught here too.
    expect(composeTerminalLaunchPrompt(input, 'cursor')).toBe(
      `${OK_TERMINAL_SURFACE_PREAMBLE} ${selectScopedPrompt(input, 'cursor', false)}`,
    );
    const claudeOut = composeTerminalLaunchPrompt(input, 'claude');
    // Both present: the surface preamble leads, the user's ask follows (no "stop").
    expect(claudeOut).toContain('summarize the open questions');
    expect(claudeOut).toContain(OK_TERMINAL_SURFACE_PREAMBLE);
    expect(claudeOut).not.toContain('Then stop.');
  });

  test('composer (compose scope) threads the typed instruction — NOT a bare launch', async () => {
    // Regression: the unified "Ask AI" composer carries its instruction in
    // `input.compose.instruction`, never the top-level `input.instruction` the
    // toolbar popover uses. A guard that checked only the latter dropped every
    // composer-typed message into the bare load+read+stop prompt — the agent got
    // a fileless "load OK, then stop" and the user's text vanished. `compose`
    // must route through `selectScopedPrompt` (-> `assembleHandoffPrompt`) just
    // like the deep-link path for the same CLI's handoff target.
    const { composeTerminalLaunchPrompt, selectScopedPrompt } = await import(
      './useHandoffDispatch'
    );
    const input = {
      docContext: null,
      compose: {
        scope: 'doc' as const,
        docRelativePath: 'notes/work-log.md',
        instruction: 'What does this file do?',
        mentions: [],
      },
      projectDir: '/proj',
      docPath: '/proj/notes/work-log.md',
    };
    expect(composeTerminalLaunchPrompt(input, 'claude')).toBe(
      `${OK_TERMINAL_SURFACE_PREAMBLE} ${selectScopedPrompt(input, 'claude-code', false)}`,
    );
    expect(composeTerminalLaunchPrompt(input, 'codex')).toBe(
      `${OK_TERMINAL_SURFACE_PREAMBLE} ${selectScopedPrompt(input, 'codex', false)}`,
    );
    expect(composeTerminalLaunchPrompt(input, 'cursor')).toBe(
      `${OK_TERMINAL_SURFACE_PREAMBLE} ${selectScopedPrompt(input, 'cursor', false)}`,
    );
    const claudeOut = composeTerminalLaunchPrompt(input, 'claude');
    // Both present: the surface preamble leads, the composer's typed ask follows.
    expect(claudeOut).toContain('What does this file do?');
    expect(claudeOut).not.toBe(composeTerminalBareLaunchPrompt('notes/work-log.md'));
    expect(claudeOut).toContain(OK_TERMINAL_SURFACE_PREAMBLE);
  });

  test('whitespace-only instruction is treated as a bare launch', async () => {
    // The `.trim()` guard in composeTerminalLaunchPrompt is deliberate: a
    // whitespace-only textarea value (e.g. '   ') must route to the bare
    // load+read+stop prompt, NOT the directive path — otherwise it would
    // resurface the open-ended "Let's work on X" prompt this PR removes.
    const { composeTerminalLaunchPrompt } = await import('./useHandoffDispatch');
    const out = composeTerminalLaunchPrompt(
      {
        docContext: { relativePath: 'notes/today.md' },
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
        instruction: '   ',
      },
      'claude',
    );
    expect(out).toBe(composeTerminalBareLaunchPrompt('notes/today.md'));
    expect(out).toContain(OK_TERMINAL_SURFACE_PREAMBLE);
    expect(out).not.toContain('Instruction:');
    expect(out).not.toContain("Let's work on");
  });

  test('create brief is preserved (keeps the directive composer)', async () => {
    const { composeTerminalLaunchPrompt, selectScopedPrompt } = await import(
      './useHandoffDispatch'
    );
    const input = {
      docContext: null,
      createDescription: 'a fishing log',
      createScenario: 'new-project' as const,
      projectDir: '/proj',
      docPath: '',
    };
    const out = composeTerminalLaunchPrompt(input, 'claude');
    expect(out).toBe(
      `${OK_TERMINAL_SURFACE_PREAMBLE} ${selectScopedPrompt(input, 'claude-code', false)}`,
    );
    expect(out).toContain('a fishing log');
    expect(out).toContain(OK_TERMINAL_SURFACE_PREAMBLE);
  });

  test('empty create brief still routes to the directive composer (createDescription !== undefined)', async () => {
    // The guard keys on `createDescription !== undefined`, not truthiness:
    // `buildCreateHandoffInput` treats the empty string as a valid create-scope
    // discriminator (it degrades to a generic "set up a new project" directive).
    // A truthiness refactor would wrongly route empty briefs to the bare prompt.
    const { composeTerminalLaunchPrompt, selectScopedPrompt } = await import(
      './useHandoffDispatch'
    );
    const input = {
      docContext: null,
      createDescription: '',
      createScenario: 'new-project' as const,
      projectDir: '/proj',
      docPath: '',
    };
    const out = composeTerminalLaunchPrompt(input, 'claude');
    expect(out).toBe(
      `${OK_TERMINAL_SURFACE_PREAMBLE} ${selectScopedPrompt(input, 'claude-code', false)}`,
    );
    expect(out).not.toBe(composeTerminalBareLaunchPrompt(null));
    expect(out).toContain(OK_TERMINAL_SURFACE_PREAMBLE);
  });

  test('bare terminal launch never carries the web-view preview trailer', async () => {
    // The terminal launches next to an already-open editor, so the web handoff's
    // "Open the OK editor in web view." directive must not appear. The web
    // handoff (autoOpen on) keeps it for the same input.
    const { composeTerminalLaunchPrompt, selectScopedPrompt } = await import(
      './useHandoffDispatch'
    );
    const input = {
      docContext: { relativePath: 'notes/today.md' },
      projectDir: '/proj',
      docPath: '/proj/notes/today.md',
    };
    expect(composeTerminalLaunchPrompt(input, 'claude')).not.toContain('Open the OK editor');
    expect(selectScopedPrompt(input, 'claude-code', true)).toContain(
      'Open the OK editor in web view.',
    );
  });
});

describe('buildAskHandoffInput — ask-scoped helper', () => {
  test('null docName returns null', async () => {
    const { buildAskHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildAskHandoffInput({
        docName: null,
        workspace: { contentDir: '/repo', pathSeparator: '/' },
        instruction: 'condense this doc',
      }),
    ).toBeNull();
  });

  test('null workspace returns null', async () => {
    const { buildAskHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildAskHandoffInput({
        docName: 'notes/today',
        workspace: null,
        instruction: 'condense this doc',
      }),
    ).toBeNull();
  });

  test('empty-string docName is treated as no active doc (null return)', async () => {
    const { buildAskHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildAskHandoffInput({
        docName: '',
        workspace: { contentDir: '/repo', pathSeparator: '/' },
        instruction: 'condense this doc',
      }),
    ).toBeNull();
  });

  test('POSIX: composes the ask payload + projectDir + absolute docPath', async () => {
    const { buildAskHandoffInput } = await import('./useHandoffDispatch');
    const input = buildAskHandoffInput({
      docName: 'specs/foo/SPEC',
      workspace: { contentDir: '/Users/andrew/repo', pathSeparator: '/' },
      instruction: 'condense this doc',
    });
    // Ask scope names a real doc, so docPath carries the absolute path
    // (consistent with file + selection scope) even though no URL builder
    // threads it. docContext stays null — the instruction rides on `ask`.
    expect(input).toEqual({
      docContext: null,
      ask: {
        relativePath: 'specs/foo/SPEC.md',
        instruction: 'condense this doc',
      },
      projectDir: '/Users/andrew/repo',
      docPath: '/Users/andrew/repo/specs/foo/SPEC.md',
    });
  });

  test('Windows: docPath uses backslashes; ask.relativePath stays POSIX', async () => {
    const { buildAskHandoffInput } = await import('./useHandoffDispatch');
    const input = buildAskHandoffInput({
      docName: 'specs/foo/SPEC',
      workspace: { contentDir: 'C:\\repo', pathSeparator: '\\' },
      instruction: '',
    });
    // relativePath stays POSIX (matches DocContext.relativePath + the MCP
    // read_document contract); only docPath uses the OS-native separator.
    expect(input?.ask?.relativePath).toBe('specs/foo/SPEC.md');
    expect(input?.projectDir).toBe('C:\\repo');
    expect(input?.docPath).toBe('C:\\repo\\specs\\foo\\SPEC.md');
  });

  test('empty instruction is allowed — passes through, not a null trigger', async () => {
    // composeAskPrompt degrades an empty instruction to the bare doc directive,
    // so dispatch is valid without one. The builder stays total (mirrors
    // buildSelectionHandoffInput's empty-instruction tolerance).
    const { buildAskHandoffInput } = await import('./useHandoffDispatch');
    const input = buildAskHandoffInput({
      docName: 'd',
      workspace: { contentDir: '/repo', pathSeparator: '/' },
      instruction: '',
    });
    expect(input).not.toBeNull();
    expect(input?.ask?.instruction).toBe('');
    expect(input?.docContext).toBeNull();
  });

  test('sets docContext null and carries the instruction on `ask` (no file-scope leak)', async () => {
    // Load-bearing: ask scope must route through composeAskPrompt, not the
    // docContext file path. The builder leaves docContext null and carries the
    // instruction on `ask` so selectScopedPrompt picks the ask branch.
    const { buildAskHandoffInput } = await import('./useHandoffDispatch');
    const input = buildAskHandoffInput({
      docName: 'notes/today',
      workspace: { contentDir: '/repo', pathSeparator: '/' },
      instruction: 'do the thing',
    });
    expect(input?.docContext).toBeNull();
    expect(input?.ask).toEqual({ relativePath: 'notes/today.md', instruction: 'do the thing' });
  });
});

describe('selectScopedPrompt — ask scope', () => {
  test('ask set returns composeAskPrompt(relativePath, instruction, autoOpen, target)', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeAskPrompt } = await import('@inkeep/open-knowledge-core');
    const out = selectScopedPrompt(
      {
        docContext: null,
        ask: { relativePath: 'notes/today.md', instruction: 'condense this doc' },
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
      },
      'claude-code',
      true,
    );
    expect(out).toBe(composeAskPrompt('notes/today.md', 'condense this doc', true, 'claude-code'));
    // The typed instruction reaches the composed prompt, blockquoted; the doc is
    // named as an @-mention.
    expect(out).toContain('> condense this doc');
    expect(out).toContain('@notes/today.md');
  });

  test('ask scope drops the preview trailer when autoOpen=false but keeps the instruction', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const out = selectScopedPrompt(
      {
        docContext: null,
        ask: { relativePath: 'notes/today.md', instruction: 'condense this doc' },
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
      },
      'claude-code',
      false,
    );
    expect(out).toContain('> condense this doc');
    expect(out).not.toContain('Open the OK editor');
  });

  test('R10 regression guard: an ask input does NOT fall through to composeFilePrompt', async () => {
    // The defining audit finding: with no selection, the legacy fallthrough
    // composes composeFilePrompt(relativePath) — which carries NO instruction. A
    // dedicated `ask` discriminator, checked before docContext, keeps the typed
    // instruction in the prompt. This pins that the ask branch wins.
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeFilePrompt, composeAskPrompt } = await import('@inkeep/open-knowledge-core');
    const out = selectScopedPrompt(
      {
        docContext: null,
        ask: { relativePath: 'notes/today.md', instruction: 'condense this doc' },
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
      },
      'claude-code',
      true,
    );
    expect(out).toContain('condense this doc');
    expect(out).not.toBe(composeFilePrompt('notes/today.md', true));
    expect(out).toBe(composeAskPrompt('notes/today.md', 'condense this doc', true, 'claude-code'));
  });

  test('precedence: ask beats docContext when both are set (defensive ordering)', async () => {
    // Production builders never set both — buildAskHandoffInput sets docContext
    // null. The defensive ordering pins ask ahead of file scope so a future
    // if-chain reorder cannot silently demote it to composeFilePrompt (which
    // would drop the instruction).
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeAskPrompt } = await import('@inkeep/open-knowledge-core');
    const out = selectScopedPrompt(
      {
        docContext: { relativePath: 'notes/today.md' },
        ask: { relativePath: 'notes/today.md', instruction: 'condense this doc' },
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
      },
      'claude-code',
      true,
    );
    expect(out).toBe(composeAskPrompt('notes/today.md', 'condense this doc', true, 'claude-code'));
  });

  test('precedence: selection beats ask when both are set (defensive ordering)', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeSelectionPrompt } = await import('@inkeep/open-knowledge-core');
    const selection = {
      relativePath: 'notes/today.md',
      instruction: 'edit the passage',
      selectionMarkdown: 'a passage',
    };
    const out = selectScopedPrompt(
      {
        docContext: null,
        selection,
        ask: { relativePath: 'notes/today.md', instruction: 'condense this doc' },
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
      },
      'claude-code',
      true,
    );
    expect(out).toBe(composeSelectionPrompt({ ...selection, target: 'claude-code' }));
  });

  test('empty instruction degrades to the bare doc directive (no dangling blockquote)', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { composeAskPrompt } = await import('@inkeep/open-knowledge-core');
    const out = selectScopedPrompt(
      {
        docContext: null,
        ask: { relativePath: 'notes/today.md', instruction: '' },
        projectDir: '/proj',
        docPath: '/proj/notes/today.md',
      },
      'claude-code',
      true,
    );
    expect(out).toBe(composeAskPrompt('notes/today.md', '', true, 'claude-code'));
    expect(out).not.toContain('>');
  });
});

describe('runHandoffDispatch — ask scope', () => {
  function askInput(instruction = 'condense this doc'): HandoffDispatchInput {
    return {
      docContext: null,
      ask: { relativePath: 'guides/style.md', instruction },
      projectDir: '/tmp/proj',
      docPath: '/tmp/proj/guides/style.md',
    };
  }

  test('composes the ask prompt and dispatches it to the picked target', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const { composeAskPrompt } = await import('@inkeep/open-knowledge-core');
    const deps = buildDeps();

    await runHandoffDispatch('claude-code', askInput(), deps);

    expect(deps.dispatchHandoff).toHaveBeenCalledTimes(1);
    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.target).toBe('claude-code');
    expect(payload.projectDir).toBe('/tmp/proj');
    expect(payload.docPath).toBe('/tmp/proj/guides/style.md');
    expect(payload.prompt).toBe(
      composeAskPrompt('guides/style.md', 'condense this doc', true, 'claude-code'),
    );
  });

  test('R10: the typed instruction is present in the dispatched prompt (no composeFilePrompt drop)', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const { composeFilePrompt } = await import('@inkeep/open-knowledge-core');
    const deps = buildDeps();

    await runHandoffDispatch(
      'codex',
      askInput('research the extinction of flightless birds'),
      deps,
    );

    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.prompt).toContain('research the extinction of flightless birds');
    // Not the bare file directive — the instruction would be dropped there.
    expect(payload.prompt).not.toBe(composeFilePrompt('guides/style.md', true));
  });

  test('ask dispatch records NO telemetry scope tag (untagged, like the directive scopes)', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps();

    await runHandoffDispatch('codex', askInput(), deps);

    expect(deps.recordHandoff).toHaveBeenCalledTimes(1);
    expect(deps.recordHandoff).toHaveBeenCalledWith({
      target: 'codex',
      host: 'electron',
      outcome: 'ok',
      ts: '2026-04-22T03:00:00.000Z',
    });
  });

  test('autoOpen=false drops the preview trailer but keeps the instruction', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps({ autoOpen: false });

    await runHandoffDispatch('codex', askInput(), deps);

    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.prompt).toContain('> condense this doc');
    expect(payload.prompt).not.toContain('Open the OK editor');
  });

  test('end-to-end: buildAskHandoffInput → dispatch carries the instruction', async () => {
    // Proves the builder + routing compose: the helper-built ask input dispatches
    // through composeAskPrompt with the typed instruction intact.
    const { runHandoffDispatch, buildAskHandoffInput } = await import('./useHandoffDispatch');
    const { composeAskPrompt } = await import('@inkeep/open-knowledge-core');
    const deps = buildDeps();
    const input = buildAskHandoffInput({
      docName: 'guides/style',
      workspace: { contentDir: '/tmp/proj', pathSeparator: '/' },
      instruction: 'make a spec from this user story',
    });
    expect(input).not.toBeNull();
    if (!input) throw new Error('unreachable'); // narrow for TS

    await runHandoffDispatch('cursor', input, deps);

    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.prompt).toBe(
      composeAskPrompt('guides/style.md', 'make a spec from this user story', true, 'cursor'),
    );
    expect(payload.prompt).toContain('make a spec from this user story');
  });
});

describe('buildComposerHandoffInput — compose-scoped helper (US-002)', () => {
  test('null workspace returns null', async () => {
    const { buildComposerHandoffInput } = await import('./useHandoffDispatch');
    expect(
      buildComposerHandoffInput({
        docName: 'notes/today',
        workspace: null,
        instruction: 'summarize',
        mentions: [],
      }),
    ).toBeNull();
  });

  test('null docName builds a project-scope compose input (no doc lead, empty docPath)', async () => {
    // a null docName is the project-scope signal, NOT a disabled trigger.
    const { buildComposerHandoffInput } = await import('./useHandoffDispatch');
    const input = buildComposerHandoffInput({
      docName: null,
      workspace: { contentDir: '/repo', pathSeparator: '/' },
      instruction: 'plan the migration',
      mentions: ['AGENTS.md'],
    });
    expect(input?.compose).toEqual({
      scope: 'project',
      instruction: 'plan the migration',
      mentions: ['AGENTS.md'],
    });
    expect(input?.docContext).toBeNull();
    expect(input?.projectDir).toBe('/repo');
    expect(input?.docPath).toBe('');
  });

  test('non-null docName builds a doc-scope compose input with the .md relative path + absolute docPath', async () => {
    const { buildComposerHandoffInput } = await import('./useHandoffDispatch');
    const input = buildComposerHandoffInput({
      docName: 'specs/foo/SPEC',
      workspace: { contentDir: '/repo', pathSeparator: '/' },
      instruction: 'tighten the intro',
      mentions: ['guides/style.md'],
    });
    expect(input?.compose).toEqual({
      scope: 'doc',
      docRelativePath: 'specs/foo/SPEC.md',
      instruction: 'tighten the intro',
      mentions: ['guides/style.md'],
    });
    expect(input?.docPath).toBe('/repo/specs/foo/SPEC.md');
  });

  test('folderRelativePath with null docName builds a folder-scope compose input (folder lead, empty docPath)', async () => {
    const { buildComposerHandoffInput } = await import('./useHandoffDispatch');
    const input = buildComposerHandoffInput({
      docName: null,
      folderRelativePath: 'specs/foo',
      workspace: { contentDir: '/repo', pathSeparator: '/' },
      instruction: 'audit this folder',
      mentions: ['AGENTS.md'],
    });
    expect(input?.compose).toEqual({
      scope: 'folder',
      folderRelativePath: 'specs/foo',
      instruction: 'audit this folder',
      mentions: ['AGENTS.md'],
    });
    expect(input?.docContext).toBeNull();
    expect(input?.projectDir).toBe('/repo');
    expect(input?.docPath).toBe('');
  });

  test('docName takes precedence over folderRelativePath (doc scope wins)', async () => {
    const { buildComposerHandoffInput } = await import('./useHandoffDispatch');
    const input = buildComposerHandoffInput({
      docName: 'notes/today',
      folderRelativePath: 'specs/foo',
      workspace: { contentDir: '/repo', pathSeparator: '/' },
      instruction: 'tidy',
      mentions: [],
    });
    expect(input?.compose?.scope).toBe('doc');
  });

  test('doc scope carries a provided selection; an omitted selection is absent', async () => {
    const { buildComposerHandoffInput } = await import('./useHandoffDispatch');
    const withSel = buildComposerHandoffInput({
      docName: 'notes/today',
      workspace: { contentDir: '/repo', pathSeparator: '/' },
      instruction: '',
      mentions: [],
      selection: { kind: 'inline', markdown: 'A wordy sentence.' },
    });
    expect(withSel?.compose).toEqual({
      scope: 'doc',
      docRelativePath: 'notes/today.md',
      instruction: '',
      mentions: [],
      selection: { kind: 'inline', markdown: 'A wordy sentence.' },
    });

    const noSel = buildComposerHandoffInput({
      docName: 'notes/today',
      workspace: { contentDir: '/repo', pathSeparator: '/' },
      instruction: '',
      mentions: [],
    });
    // No selection passed → the field is absent. The composer elides an empty
    // selection before calling the builder.
    expect(noSel?.compose).not.toHaveProperty('selection');
  });
});

describe('selectScopedPrompt — compose scope (US-002)', () => {
  test('doc scope routes through assembleHandoffPrompt for the target (doc lead + mentions present)', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { assembleHandoffPrompt } = await import('@inkeep/open-knowledge-core');
    const input: HandoffDispatchInput = {
      docContext: null,
      compose: {
        scope: 'doc',
        docRelativePath: 'specs/foo/SPEC.md',
        instruction: 'tighten the intro',
        mentions: ['guides/style.md', 'AGENTS.md'],
      },
      projectDir: '/repo',
      docPath: '/repo/specs/foo/SPEC.md',
    };
    const out = selectScopedPrompt(input, 'cursor', true);
    // Byte-equality with the assembler proves the compose path is the holistic
    // assembler, NOT a per-composer fit.
    expect(out).toBe(
      assembleHandoffPrompt({
        scope: 'doc',
        docRelativePath: 'specs/foo/SPEC.md',
        instruction: 'tighten the intro',
        mentions: ['guides/style.md', 'AGENTS.md'],
        autoOpen: true,
        target: 'cursor',
      }),
    );
    expect(out).toContain('@specs/foo/SPEC.md');
    expect(out).toContain('@guides/style.md');
    expect(out).toContain('@AGENTS.md');
    expect(out).toContain('> tighten the intro');
  });

  test('folder scope routes through assembleHandoffPrompt with the folder @-mention lead + mentions', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { assembleHandoffPrompt } = await import('@inkeep/open-knowledge-core');
    const input: HandoffDispatchInput = {
      docContext: null,
      compose: {
        scope: 'folder',
        folderRelativePath: 'specs/foo',
        instruction: 'audit this folder',
        mentions: ['AGENTS.md'],
      },
      projectDir: '/repo',
      docPath: '',
    };
    const out = selectScopedPrompt(input, 'cursor', true);
    expect(out).toBe(
      assembleHandoffPrompt({
        scope: 'folder',
        folderRelativePath: 'specs/foo',
        instruction: 'audit this folder',
        mentions: ['AGENTS.md'],
        autoOpen: true,
        target: 'cursor',
      }),
    );
    expect(out).toContain('@specs/foo folder');
    expect(out).toContain('@AGENTS.md');
    expect(out).toContain('> audit this folder');
  });

  test('project scope routes through assembleHandoffPrompt with no doc @-mention', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { assembleHandoffPrompt } = await import('@inkeep/open-knowledge-core');
    const input: HandoffDispatchInput = {
      docContext: null,
      compose: { scope: 'project', instruction: 'plan the migration', mentions: [] },
      projectDir: '/repo',
      docPath: '',
    };
    const out = selectScopedPrompt(input, 'codex', true);
    expect(out).toBe(
      assembleHandoffPrompt({
        scope: 'project',
        instruction: 'plan the migration',
        mentions: [],
        autoOpen: true,
        target: 'codex',
      }),
    );
    expect(out).toContain('plan the migration');
    expect(out).not.toContain('@');
  });

  test('doc scope with a selection threads the passage to the assembler', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { assembleHandoffPrompt } = await import('@inkeep/open-knowledge-core');
    const input: HandoffDispatchInput = {
      docContext: null,
      compose: {
        scope: 'doc',
        docRelativePath: 'notes/today.md',
        instruction: 'make concise',
        mentions: [],
        selection: { kind: 'inline', markdown: 'This sentence is wordy.' },
      },
      projectDir: '/repo',
      docPath: '/repo/notes/today.md',
    };
    const out = selectScopedPrompt(input, 'claude-code', true);
    expect(out).toBe(
      assembleHandoffPrompt({
        scope: 'doc',
        docRelativePath: 'notes/today.md',
        instruction: 'make concise',
        mentions: [],
        selection: { kind: 'inline', markdown: 'This sentence is wordy.' },
        autoOpen: true,
        target: 'claude-code',
      }),
    );
    expect(out).toContain('This sentence is wordy.');
  });

  test('precedence: compose beats selection + docContext when several are set (defensive ordering)', async () => {
    // Production builders never set more than one scope field. The defensive
    // ordering pins compose as the most specific so a future if-chain reorder
    // can't silently demote the unified composer path.
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const { assembleHandoffPrompt } = await import('@inkeep/open-knowledge-core');
    const input: HandoffDispatchInput = {
      docContext: { relativePath: 'a.md' },
      selection: { relativePath: 'a.md', instruction: 'x', selectionMarkdown: 'p' },
      compose: { scope: 'project', instruction: 'unified path wins', mentions: [] },
      projectDir: '/repo',
      docPath: '/repo/a.md',
    };
    const out = selectScopedPrompt(input, 'claude-code', true);
    expect(out).toBe(
      assembleHandoffPrompt({
        scope: 'project',
        instruction: 'unified path wins',
        mentions: [],
        autoOpen: true,
        target: 'claude-code',
      }),
    );
  });

  test('autoOpen=false drops the "Open the OK editor" trailer via the assembler', async () => {
    const { selectScopedPrompt } = await import('./useHandoffDispatch');
    const input: HandoffDispatchInput = {
      docContext: null,
      compose: { scope: 'project', instruction: 'plan', mentions: [] },
      projectDir: '/repo',
      docPath: '',
    };
    const out = selectScopedPrompt(input, 'codex', false);
    expect(out).not.toContain('Open the OK editor');
  });
});

describe('runHandoffDispatch — compose scope (US-002)', () => {
  function composeProjectInput(): HandoffDispatchInput {
    return {
      docContext: null,
      compose: { scope: 'project', instruction: 'plan the migration', mentions: [] },
      projectDir: '/tmp/proj',
      docPath: '',
    };
  }

  test('project scope: composes via the assembler, prompt has the instruction + no doc mention, empty docPath dispatched (R1 dispatch half)', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const { assembleHandoffPrompt } = await import('@inkeep/open-knowledge-core');
    const deps = buildDeps();

    await runHandoffDispatch('codex', composeProjectInput(), deps);

    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.docPath).toBe('');
    expect(payload.prompt).toBe(
      assembleHandoffPrompt({
        scope: 'project',
        instruction: 'plan the migration',
        mentions: [],
        autoOpen: true,
        target: 'codex',
      }),
    );
    expect(payload.prompt).toContain('plan the migration');
    expect(payload.prompt).not.toContain('@');
  });

  test('multi-mention doc scope: every sanitized @path appears in the dispatched prompt (R4 dispatch half)', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps();
    const input: HandoffDispatchInput = {
      docContext: null,
      compose: {
        scope: 'doc',
        docRelativePath: 'specs/foo/SPEC.md',
        instruction: 'compare these',
        mentions: ['guides/style.md', 'AGENTS.md'],
      },
      projectDir: '/tmp/proj',
      docPath: '/tmp/proj/specs/foo/SPEC.md',
    };

    await runHandoffDispatch('claude-code', input, deps);

    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.prompt).toContain('@specs/foo/SPEC.md');
    expect(payload.prompt).toContain('@guides/style.md');
    expect(payload.prompt).toContain('@AGENTS.md');
  });

  test('selection passage embedded + telemetry scope tagged selection (R5 dispatch half)', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps();
    const input: HandoffDispatchInput = {
      docContext: null,
      compose: {
        scope: 'doc',
        docRelativePath: 'notes/today.md',
        instruction: 'make concise',
        mentions: [],
        selection: { kind: 'inline', markdown: 'This sentence is wordy.' },
      },
      projectDir: '/tmp/proj',
      docPath: '/tmp/proj/notes/today.md',
    };

    await runHandoffDispatch('codex', input, deps);

    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.prompt).toContain('This sentence is wordy.');
    expect(deps.recordHandoff).toHaveBeenCalledWith({
      target: 'codex',
      host: 'electron',
      outcome: 'ok',
      ts: '2026-04-22T03:00:00.000Z',
      scope: 'selection',
    });
  });

  test('compose with no passage stays untagged (no scope field on the telemetry line)', async () => {
    const { runHandoffDispatch } = await import('./useHandoffDispatch');
    const deps = buildDeps();

    await runHandoffDispatch('codex', composeProjectInput(), deps);

    expect(deps.recordHandoff).toHaveBeenCalledWith({
      target: 'codex',
      host: 'electron',
      outcome: 'ok',
      ts: '2026-04-22T03:00:00.000Z',
    });
  });

  test('end-to-end: buildComposerHandoffInput (no doc) → dispatch carries the instruction, no doc mention', async () => {
    const { runHandoffDispatch, buildComposerHandoffInput } = await import('./useHandoffDispatch');
    const deps = buildDeps();
    const input = buildComposerHandoffInput({
      docName: null,
      workspace: { contentDir: '/tmp/proj', pathSeparator: '/' },
      instruction: 'set up CI',
      mentions: [],
    });
    expect(input).not.toBeNull();
    if (!input) throw new Error('unreachable'); // narrow for TS

    await runHandoffDispatch('cursor', input, deps);

    const [payload] = (deps.dispatchHandoff as ReturnType<typeof mock>).mock.calls[0] as [
      HandoffPayload,
    ];
    expect(payload.docPath).toBe('');
    expect(payload.prompt).toContain('set up CI');
    expect(payload.prompt).not.toContain('@');
  });
});

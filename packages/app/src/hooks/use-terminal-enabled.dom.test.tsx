/**
 * Behavioral tests for the terminal-consent reader + writer hooks, exercised
 * through a real ConfigContext provider with a fake project-local binding.
 *
 * The boundary mocked is the system one — the CRDT-backed ConfigBinding. The
 * assertions pin what these hooks own: reading the tri-state from the
 * project-local layer, and routing grant/revoke to `terminal.enabled` via the
 * binding's `patch` (the human-only write path).
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import type { Config, ConfigBinding, ConfigPatch } from '@inkeep/open-knowledge-core';
import { cleanup, render } from '@testing-library/react';
import { ConfigContext, type ConfigContextValue } from '@/lib/config-context';
import type { TerminalConsentState, TerminalEnabledWriter } from './use-terminal-enabled';

const consentGrants: true[] = [];
mock.module('@/lib/terminal-telemetry', () => ({
  recordShellConsentGranted: () => consentGrants.push(true),
  recordTerminalOpened: () => undefined,
}));

// Load the hooks AFTER the mock registers — `mock.module` is not hoisted, but a
// static import is, so a static import of the subject would bind the real
// telemetry module before the mock takes effect.
let useTerminalConsentState: typeof import('./use-terminal-enabled').useTerminalConsentState;
let useTerminalEnabledWriter: typeof import('./use-terminal-enabled').useTerminalEnabledWriter;
beforeAll(async () => {
  const mod = await import('./use-terminal-enabled');
  useTerminalConsentState = mod.useTerminalConsentState;
  useTerminalEnabledWriter = mod.useTerminalEnabledWriter;
});

const emptyContext: ConfigContextValue = {
  userBinding: null,
  userSynced: false,
  projectBinding: null,
  projectLocalBinding: null,
  okignoreBinding: null,
  okignoreSynced: false,
  userConfig: null,
  projectConfig: null,
  projectLocalConfig: null,
  projectSynced: false,
  projectLocalSynced: false,
  merged: null,
};

type FakePatchResult = { ok: true } | { ok: false; error: { code: 'WRITE_ERROR'; detail: string } };

function makeFakeBinding(result: FakePatchResult): {
  binding: ConfigBinding;
  patches: ConfigPatch[];
} {
  const patches: ConfigPatch[] = [];
  const binding = {
    patch: (patch: ConfigPatch) => {
      patches.push(patch);
      return result;
    },
  } as unknown as ConfigBinding;
  return { binding, patches };
}

let captured: { state: TerminalConsentState; writer: TerminalEnabledWriter | null } | null = null;

function Probe() {
  const state = useTerminalConsentState();
  const writer = useTerminalEnabledWriter();
  captured = { state, writer };
  return null;
}

function renderWith(value: ConfigContextValue) {
  render(
    <ConfigContext value={value}>
      <Probe />
    </ConfigContext>,
  );
}

describe('useTerminalConsentState', () => {
  afterEach(() => {
    cleanup();
    captured = null;
  });

  test('reads the project-local terminal.enabled tri-state', () => {
    renderWith({
      ...emptyContext,
      projectLocalConfig: { terminal: { enabled: true } } as unknown as Config,
      projectLocalSynced: true,
    });
    expect(captured?.state).toEqual({ enabled: true, synced: true });

    cleanup();
    renderWith({
      ...emptyContext,
      projectLocalConfig: { terminal: { enabled: false } } as unknown as Config,
      projectLocalSynced: true,
    });
    expect(captured?.state).toEqual({ enabled: false, synced: true });
  });

  test('coalesces an absent terminal leaf to null (unanswered)', () => {
    renderWith({
      ...emptyContext,
      projectLocalConfig: {} as unknown as Config,
      projectLocalSynced: true,
    });
    expect(captured?.state).toEqual({ enabled: null, synced: true });
  });

  test('reports synced:false during cold start so null is not mistaken for unanswered', () => {
    renderWith({ ...emptyContext, projectLocalConfig: null, projectLocalSynced: false });
    expect(captured?.state).toEqual({ enabled: null, synced: false });
  });
});

describe('useTerminalEnabledWriter', () => {
  afterEach(() => {
    cleanup();
    captured = null;
    consentGrants.length = 0;
  });

  test('is null until the project-local binding mounts', () => {
    renderWith(emptyContext);
    expect(captured?.writer).toBeNull();
  });

  test('grant patches terminal.enabled true on the project-local binding', () => {
    const { binding, patches } = makeFakeBinding({ ok: true });
    renderWith({ ...emptyContext, projectLocalBinding: binding });

    const result = captured?.writer?.(true);
    expect(result).toEqual({ ok: true });
    expect(patches).toEqual([{ terminal: { enabled: true } }]);
  });

  test('revoke patches terminal.enabled false on the project-local binding', () => {
    const { binding, patches } = makeFakeBinding({ ok: true });
    renderWith({ ...emptyContext, projectLocalBinding: binding });

    const result = captured?.writer?.(false);
    expect(result).toEqual({ ok: true });
    expect(patches).toEqual([{ terminal: { enabled: false } }]);
  });

  test('maps a binding write failure to a tagged error result', () => {
    const { binding } = makeFakeBinding({
      ok: false,
      error: { code: 'WRITE_ERROR', detail: 'disk full' },
    });
    renderWith({ ...emptyContext, projectLocalBinding: binding });

    const result = captured?.writer?.(true);
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(typeof result.error).toBe('string');
  });

  test('a successful grant records the shell-consent-granted event once', () => {
    const { binding } = makeFakeBinding({ ok: true });
    renderWith({ ...emptyContext, projectLocalBinding: binding });

    captured?.writer?.(true);
    expect(consentGrants).toHaveLength(1);
  });

  test('a revoke does not record a consent grant', () => {
    const { binding } = makeFakeBinding({ ok: true });
    renderWith({ ...emptyContext, projectLocalBinding: binding });

    captured?.writer?.(false);
    expect(consentGrants).toEqual([]);
  });

  test('a failed grant write does not record a consent grant', () => {
    const { binding } = makeFakeBinding({
      ok: false,
      error: { code: 'WRITE_ERROR', detail: 'disk full' },
    });
    renderWith({ ...emptyContext, projectLocalBinding: binding });

    captured?.writer?.(true);
    expect(consentGrants).toEqual([]);
  });
});

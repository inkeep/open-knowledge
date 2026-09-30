import type {
  HandoffOutcome,
  HandoffTarget,
  HostSnapshot,
  InstallState,
} from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ApplyAgentConnectionsResult } from '@/lib/agent-connections';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import { terminalAgentSnapshot } from '../terminal-agent-connections.test-helper';
import type { HandoffDispatchInput } from './useHandoffDispatch';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ i18n: { locale: 'en' }, t: renderLinguiTemplate }),
}));

const moduleDispatch = vi.fn(async () => ({ ok: true as const }));
const toastError = vi.fn();
const recordHandoff = vi.fn(async () => undefined);
vi.doMock('@/lib/config-context', () => ({
  useConfigContext: () => ({ merged: null }),
}));
vi.doMock('@/lib/handoff/dispatch', () => ({ dispatchHandoff: moduleDispatch }));
vi.doMock('@/lib/handoff/telemetry', () => ({ recordHandoff }));
vi.doMock('sonner', () => ({
  toast: { error: toastError, success: vi.fn() },
}));

const { ExternalHandoffGateProvider, useExternalHandoffGate } = await import(
  './ExternalHandoffGate'
);
const { useHandoffDispatch } = await import('./useHandoffDispatch');

const input: HandoffDispatchInput = {
  docContext: { relativePath: 'notes/example.md' },
  instruction: 'Summarize this note',
  projectDir: '/project',
  docPath: '/project/notes/example.md',
};

function result(snapshot: ApplyAgentConnectionsResult['snapshot']): ApplyAgentConnectionsResult {
  return {
    ok: snapshot !== null,
    report: { actions: [], conflicts: [], withheld: [] },
    snapshot,
  };
}

function unavailableResult(): ApplyAgentConnectionsResult {
  return {
    ok: false,
    unavailable: true,
    report: { actions: [], conflicts: [], withheld: [] },
    snapshot: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function GateHarness({
  rawDispatch,
  target = 'claude-code',
  dispatchInput = input,
  onOutcome,
  onError,
}: {
  rawDispatch: (target: HandoffTarget, input: HandoffDispatchInput) => Promise<HandoffOutcome>;
  target?: HandoffTarget;
  dispatchInput?: HandoffDispatchInput;
  onOutcome?: (outcome: HandoffOutcome) => void;
  onError?: (error: unknown) => void;
}) {
  const gate = useExternalHandoffGate();
  return (
    <Button
      onClick={() =>
        void gate
          .dispatch(target, () => rawDispatch(target, dispatchInput), {
            projectDir: dispatchInput.projectDir,
            installState: { installed: true, lastChecked: 1 },
          })
          .then(onOutcome, onError)
      }
    >
      Open {target}
    </Button>
  );
}

function DismissingPickerHarness({
  rawDispatch,
}: {
  rawDispatch: (target: HandoffTarget, input: HandoffDispatchInput) => Promise<HandoffOutcome>;
}) {
  const gate = useExternalHandoffGate();
  const [pickerOpen, setPickerOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!pickerOpen) triggerRef.current?.focus();
  }, [pickerOpen]);
  return (
    <>
      <Button ref={triggerRef}>Open with AI</Button>
      {pickerOpen ? (
        <Button
          onClick={() => {
            void gate.dispatch('claude-code', () => rawDispatch('claude-code', input), {
              projectDir: input.projectDir,
              installState: { installed: true, lastChecked: 1 },
            });
            setPickerOpen(false);
          }}
        >
          Claude Code
        </Button>
      ) : null}
    </>
  );
}

function UnmountingPickerHarness({
  rawDispatch,
}: {
  rawDispatch: (target: HandoffTarget, input: HandoffDispatchInput) => Promise<HandoffOutcome>;
}) {
  const gate = useExternalHandoffGate();
  const [pickerOpen, setPickerOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={triggerRef}>Open with AI</Button>
      {pickerOpen ? (
        <Button
          onClick={() => {
            void gate.dispatch('claude-code', () => rawDispatch('claude-code', input), {
              projectDir: input.projectDir,
              installState: { installed: true, lastChecked: 1 },
              restoreFocus: () => triggerRef.current?.focus(),
            });
            setPickerOpen(false);
          }}
        >
          Claude Code
        </Button>
      ) : null}
    </>
  );
}

function SharedHookHarness({
  target = 'claude-code',
  installState = { installed: true, lastChecked: 1 },
  onOutcome,
}: {
  target?: HandoffTarget;
  installState?: InstallState;
  onOutcome?: (outcome: HandoffOutcome) => void;
}) {
  const { dispatch } = useHandoffDispatch();
  return (
    <Button onClick={() => void dispatch(target, input, { installState }).then(onOutcome)}>
      Open from shared hook
    </Button>
  );
}

function renderGate(
  applyConnections: Parameters<typeof ExternalHandoffGateProvider>[0]['applyConnections'],
  children: ReactNode,
) {
  return render(
    <TooltipProvider>
      <ExternalHandoffGateProvider applyConnections={applyConnections}>
        {children}
      </ExternalHandoffGateProvider>
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('ExternalHandoffGate', () => {
  test('a known absent app stops at the shared hook before setup or transport', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const onOutcome = vi.fn();
    renderGate(
      applyConnections,
      <SharedHookHarness
        target="codex"
        installState={{ installed: false, lastChecked: 1 }}
        onOutcome={onOutcome}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open from shared hook' }));

    await waitFor(() =>
      expect(onOutcome).toHaveBeenCalledWith({ ok: false, reason: 'not-installed' }),
    );
    expect(applyConnections).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(moduleDispatch).not.toHaveBeenCalled();
    expect(recordHandoff).toHaveBeenCalledExactlyOnceWith({
      target: 'codex',
      host: 'web',
      outcome: 'error',
      reason: 'not-installed',
      ts: expect.any(String),
    });
  });

  test('unknown installation state still evaluates connection readiness', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot(['claude'])));
    const onOutcome = vi.fn();
    renderGate(
      applyConnections,
      <SharedHookHarness installState={{ installed: null }} onOutcome={onOutcome} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open from shared hook' }));

    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith({ ok: true }));
    expect(applyConnections).toHaveBeenCalledExactlyOnceWith([], {
      webSignal: expect.any(AbortSignal),
    });
    expect(moduleDispatch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a fast readiness check completes without showing a delayed checking status', async () => {
    vi.useFakeTimers();
    const read = deferred<ApplyAgentConnectionsResult>();
    const applyConnections = vi.fn(() => read.promise);
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    const onOutcome = vi.fn();
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} onOutcome={onOutcome} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => read.resolve(result(terminalAgentSnapshot(['claude']))));
    expect(rawDispatch).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(500));

    expect(screen.queryByRole('status')).toBeNull();
    expect(onOutcome).toHaveBeenCalledWith({ ok: true });
  });

  test('a slow readiness check exposes a perceivable status after a short delay', async () => {
    vi.useFakeTimers();
    const read = deferred<ApplyAgentConnectionsResult>();
    const applyConnections = vi.fn(() => read.promise);
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(500));

    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/Claude/i);
    expect(rawDispatch).not.toHaveBeenCalled();
    await act(async () => read.resolve(result(terminalAgentSnapshot(['claude']))));
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('a stalled readiness read fails open within a bounded time and warns before dispatch', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = deferred<ApplyAgentConnectionsResult>();
    const applyConnections = vi.fn(() => read.promise);
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    const onOutcome = vi.fn();
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} onOutcome={onOutcome} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    expect(rawDispatch).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(300_000));

    expect(warn).toHaveBeenCalledWith('[handoff] external readiness check bypassed', {
      target: 'claude-code',
      cause: 'read-timeout',
    });
    expect(warn.mock.invocationCallOrder[0]).toBeLessThan(
      rawDispatch.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(rawDispatch).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith({ ok: true });
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => read.reject(new Error('aborted after timeout')));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(rawDispatch).toHaveBeenCalledTimes(1);
  });

  test('provider teardown settles a pending caller without launching the destination', async () => {
    const applyConnections = vi.fn(() => new Promise<ApplyAgentConnectionsResult>(() => {}));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    const onOutcome = vi.fn();
    const view = renderGate(
      applyConnections,
      <GateHarness rawDispatch={rawDispatch} onOutcome={onOutcome} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    expect(onOutcome).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => {});

    expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(rawDispatch).not.toHaveBeenCalled();
  });

  test('a ready installed target dispatches once after a fresh connection check', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot(['claude'])));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} />);

    await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));

    await waitFor(() => expect(rawDispatch).toHaveBeenCalledTimes(1));
    expect(rawDispatch).toHaveBeenCalledWith('claude-code', input);
    expect(applyConnections).toHaveBeenCalledTimes(1);
    expect(applyConnections).toHaveBeenCalledWith([], {
      webSignal: expect.any(AbortSignal),
    });
  });

  test('a synchronous destination error rejects the caller after a ready check', async () => {
    const failure = new Error('launch failed');
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot(['claude'])));
    const rawDispatch = vi.fn(() => {
      throw failure;
    });
    const onError = vi.fn();
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} onError={onError} />);

    await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));

    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(failure));
    expect(rawDispatch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('the shared handoff hook reaches raw transport only through the provider gate', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot(['claude'])));
    renderGate(applyConnections, <SharedHookHarness />);

    await userEvent.click(screen.getByRole('button', { name: 'Open from shared hook' }));

    await waitFor(() => expect(moduleDispatch).toHaveBeenCalledTimes(1));
    expect(applyConnections).toHaveBeenCalledWith([], {
      webSignal: expect.any(AbortSignal),
    });
    expect(moduleDispatch.mock.calls[0]?.[0]).toMatchObject({
      target: 'claude-code',
      projectDir: '/project',
      docPath: '/project/notes/example.md',
    });
  });

  test('a transport Retry performs another fresh check before dispatching again', async () => {
    moduleDispatch
      .mockResolvedValueOnce({ ok: false, reason: 'dispatch-error' })
      .mockResolvedValueOnce({ ok: true });
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot(['claude'])));
    renderGate(applyConnections, <SharedHookHarness />);

    await userEvent.click(screen.getByRole('button', { name: 'Open from shared hook' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));

    const retry = toastError.mock.calls[0]?.[1]?.action?.onClick;
    expect(retry).toBeTypeOf('function');
    await act(async () => retry?.());

    await waitFor(() => expect(moduleDispatch).toHaveBeenCalledTimes(2));
    expect(applyConnections).toHaveBeenCalledTimes(2);
    expect(applyConnections.mock.invocationCallOrder[1]).toBeLessThan(
      moduleDispatch.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
  });

  test('a transport Retry opens setup when the prerequisite was revoked', async () => {
    moduleDispatch.mockResolvedValueOnce({ ok: false, reason: 'dispatch-error' });
    const applyConnections = vi
      .fn(async () => result(terminalAgentSnapshot()))
      .mockResolvedValueOnce(result(terminalAgentSnapshot(['claude'])));
    renderGate(applyConnections, <SharedHookHarness />);

    await userEvent.click(screen.getByRole('button', { name: 'Open from shared hook' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    const retry = toastError.mock.calls[0]?.[1]?.action?.onClick;
    await act(async () => retry?.());

    expect((await screen.findByRole('dialog')).textContent).toContain(
      'Choose what OpenKnowledge sets up for Claude.',
    );
    expect(applyConnections).toHaveBeenCalledTimes(2);
    expect(moduleDispatch).toHaveBeenCalledTimes(1);
  });

  test('an unmet prerequisite opens setup and cancel leaves the app closed', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    const onOutcome = vi.fn();
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} onOutcome={onOutcome} />);

    await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));

    expect((await screen.findByRole('dialog')).textContent).toContain(
      'Choose what OpenKnowledge sets up for Claude.',
    );
    expect(rawDispatch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rawDispatch).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith({
      ok: false,
      reason: 'setup-canceled',
    });
    expect(recordHandoff).toHaveBeenCalledExactlyOnceWith({
      target: 'claude-code',
      host: 'web',
      outcome: 'error',
      reason: 'setup-canceled',
      ts: expect.any(String),
    });
  });

  test('skill-only setup explains that an MCP server is required', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} target="cursor" />);

    await userEvent.click(screen.getByRole('button', { name: 'Open cursor' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Project MCP server' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Project skill' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Global MCP server' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'To save this setup, turn on Project MCP server or Global MCP server.',
    );
    expect(applyConnections).toHaveBeenCalledTimes(1);
    expect(rawDispatch).not.toHaveBeenCalled();
    expect(dialog).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Project MCP server' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  test('opening the destination dispatches once without writing setup', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} target="cursor" />);

    await userEvent.click(screen.getByRole('button', { name: 'Open cursor' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Open Cursor' }));

    await waitFor(() => expect(rawDispatch).toHaveBeenCalledTimes(1));
    expect(applyConnections).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test("Don't ask again skips setup for the same target and project", async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} target="cursor" />);

    await userEvent.click(screen.getByRole('button', { name: 'Open cursor' }));
    await screen.findByRole('dialog');
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: "Don't ask again when opening this app without setup in this project",
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open Cursor' }));
    await waitFor(() => expect(rawDispatch).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Open cursor' }));

    await waitFor(() => expect(rawDispatch).toHaveBeenCalledTimes(2));
    expect(applyConnections).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('skipping one app still asks for a different app in the same project', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(
      applyConnections,
      <>
        <GateHarness rawDispatch={rawDispatch} target="cursor" />
        <GateHarness rawDispatch={rawDispatch} target="claude-code" />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open cursor' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('checkbox', { name: /Don't ask again/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Open Cursor' }));
    await waitFor(() => expect(rawDispatch).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    expect((await screen.findByRole('dialog')).textContent).toContain('Claude');
    expect(applyConnections).toHaveBeenCalledTimes(2);
  });

  test('skipping one project still asks for the same app in another project', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(
      applyConnections,
      <>
        <GateHarness rawDispatch={rawDispatch} target="cursor" />
        <GateHarness
          rawDispatch={rawDispatch}
          target="cursor"
          dispatchInput={{ ...input, projectDir: '/another-project' }}
        />
      </>,
    );

    const openButtons = screen.getAllByRole('button', { name: 'Open cursor' });
    await userEvent.click(openButtons[0]);
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('checkbox', { name: /Don't ask again/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Open Cursor' }));
    await waitFor(() => expect(rawDispatch).toHaveBeenCalledTimes(1));

    await userEvent.click(openButtons[1]);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(applyConnections).toHaveBeenCalledTimes(2);
  });

  test('opening without selecting skip asks again next time', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} target="cursor" />);

    await userEvent.click(screen.getByRole('button', { name: 'Open cursor' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Open Cursor' }));
    await waitFor(() => expect(rawDispatch).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Open cursor' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(applyConnections).toHaveBeenCalledTimes(2);
  });

  test('cancel after selecting skip still asks next time', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} target="cursor" />);

    await userEvent.click(screen.getByRole('button', { name: 'Open cursor' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('checkbox', { name: /Don't ask again/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Open cursor' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(applyConnections).toHaveBeenCalledTimes(2);
    expect(rawDispatch).not.toHaveBeenCalled();
  });

  test('Escape closes setup without dispatching', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rawDispatch).not.toHaveBeenCalled();
  });

  test('Escape closes a nested information tooltip before setup', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    await screen.findByRole('dialog');

    const informationTrigger = screen.getAllByRole('button', { name: 'More information' })[0];
    informationTrigger.focus();
    await screen.findByRole('tooltip');
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rawDispatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open claude-code' }));
  });

  test('closing setup restores focus to the stable picker trigger', async () => {
    const read = deferred<ApplyAgentConnectionsResult>();
    const applyConnections = vi.fn(() => read.promise);
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <DismissingPickerHarness rawDispatch={rawDispatch} />);
    await userEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open with AI' }));
    await act(async () => read.resolve(result(terminalAgentSnapshot())));
    await screen.findByRole('dialog');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open with AI' })),
    );
  });

  test('closing setup uses the caller focus fallback after the initiating item unmounts', async () => {
    const read = deferred<ApplyAgentConnectionsResult>();
    const applyConnections = vi.fn(() => read.promise);
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <UnmountingPickerHarness rawDispatch={rawDispatch} />);

    await userEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    expect(screen.queryByRole('button', { name: 'Claude Code' })).toBeNull();
    await act(async () => read.resolve(result(terminalAgentSnapshot())));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open with AI' })),
    );
    expect(rawDispatch).not.toHaveBeenCalled();
  });

  test('closing setup uses the caller focus fallback when the initiating click leaves body active', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <UnmountingPickerHarness rawDispatch={rawDispatch} />);

    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open with AI' })),
    );
    expect(rawDispatch).not.toHaveBeenCalled();
  });

  test('successful setup resumes the complete pending handoff exactly once', async () => {
    const applyConnections = vi
      .fn(async () => result(terminalAgentSnapshot()))
      .mockResolvedValueOnce(result(terminalAgentSnapshot()))
      .mockResolvedValueOnce(result(terminalAgentSnapshot(['claude'])));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    const completeInput: HandoffDispatchInput = {
      ...input,
      selection: {
        relativePath: 'notes/example.md',
        instruction: 'Explain this selection',
        selectionMarkdown: '**selected**',
      },
      attachments: [{ kind: 'file', name: 'diagram.png', path: '/project/diagram.png' }],
    };
    renderGate(
      applyConnections,
      <GateHarness rawDispatch={rawDispatch} dispatchInput={completeInput} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    await screen.findByRole('dialog');

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(rawDispatch).toHaveBeenCalledTimes(1));
    expect(rawDispatch).toHaveBeenCalledWith('claude-code', completeInput);
    expect(applyConnections).toHaveBeenCalledTimes(2);
    expect(applyConnections.mock.calls[1]?.[0].length).toBeGreaterThan(0);
  });

  test('setup stays open when its returned snapshot is still not ready', async () => {
    const applyConnections = vi.fn(async () => result(terminalAgentSnapshot()));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    await screen.findByRole('dialog');

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(applyConnections).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('dialog')).toBeTruthy();
    const savedNotice = screen.getByText(/Changes were saved, but OpenKnowledge could not confirm/);
    expect(savedNotice.closest('[role="status"]')).toBeTruthy();
    expect(savedNotice.textContent).toContain(
      'Changes were saved, but OpenKnowledge could not confirm a connection to Claude.',
    );
    expect(savedNotice.textContent).toContain(
      'Check the MCP server settings for this app, then select Save changes to check again.',
    );
    expect(screen.queryByText('Something went wrong. Please try again.')).toBeNull();
    expect(rawDispatch).not.toHaveBeenCalled();
  });

  test('a malformed post-save snapshot reports that changes were saved', async () => {
    const malformedSnapshot = {
      ...terminalAgentSnapshot(),
      detection: null,
    } as unknown as HostSnapshot;
    const applyConnections = vi
      .fn()
      .mockResolvedValueOnce(result(terminalAgentSnapshot()))
      .mockResolvedValueOnce(result(malformedSnapshot));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    await screen.findByRole('dialog');

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const savedNotice = await screen.findByText(
      /Changes were saved, but OpenKnowledge could not confirm/,
    );
    expect(savedNotice.closest('[role="status"]')).toBeTruthy();
    expect(screen.queryByText('Something went wrong. Please try again.')).toBeNull();
    expect(rawDispatch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[handoff] external readiness check bypassed', {
      target: 'claude-code',
      cause: 'derivation-threw',
      detail: expect.stringContaining('Cannot read properties of null'),
    });
  });

  test.each([
    ['unavailable', async () => unavailableResult(), 'unavailable', undefined],
    [
      'failed read',
      async () => ({ ...result(null), error: 'HTTP 503 Service Unavailable' }),
      'read-failed',
      'HTTP 503 Service Unavailable',
    ],
    [
      'missing snapshot',
      async () => ({ ...result(null), ok: true }),
      'missing-snapshot',
      undefined,
    ],
    [
      'malformed snapshot',
      async () =>
        result({
          ...terminalAgentSnapshot(),
          detection: null,
        } as unknown as HostSnapshot),
      'derivation-threw',
      expect.stringContaining('Cannot read properties of null'),
    ],
    [
      'unknown status',
      async () =>
        result({
          probes: { env: 'desktop', satisfiers: {} },
          detection: { detected: ['claude'], probed: true },
        } satisfies HostSnapshot),
      'unknown-status',
      'no-status',
    ],
  ])(
    '%s checks fail open with a cause-specific warning',
    async (_name, firstRead, cause, detail) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const applyConnections = vi.fn(firstRead);
      const rawDispatch = vi.fn(async () => ({ ok: true as const }));
      renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} />);
      await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));

      await waitFor(() => expect(rawDispatch).toHaveBeenCalledTimes(1));
      expect(warn).toHaveBeenCalledWith('[handoff] external readiness check bypassed', {
        target: 'claude-code',
        cause,
        ...(detail === undefined ? {} : { detail }),
      });
      expect(warn.mock.invocationCallOrder[0]).toBeLessThan(
        rawDispatch.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(applyConnections).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    },
  );

  test('a rejected check fails open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const applyConnections = vi.fn(async () => {
      throw new Error('offline');
    });
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(applyConnections, <GateHarness rawDispatch={rawDispatch} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));

    await waitFor(() => expect(rawDispatch).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith('[handoff] external readiness check bypassed', {
      target: 'claude-code',
      cause: 'read-threw',
      detail: 'offline',
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('a newer request supersedes an older readiness check', async () => {
    const first = deferred<ApplyAgentConnectionsResult>();
    const second = deferred<ApplyAgentConnectionsResult>();
    const applyConnections = vi
      .fn<() => Promise<ApplyAgentConnectionsResult>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    const firstOutcome = vi.fn();
    renderGate(
      applyConnections,
      <>
        <GateHarness rawDispatch={rawDispatch} onOutcome={firstOutcome} />
        <GateHarness rawDispatch={rawDispatch} target="cursor" />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open cursor' }));
    await waitFor(() =>
      expect(firstOutcome).toHaveBeenCalledWith({ ok: false, reason: 'superseded' }),
    );
    await act(async () => second.resolve(result(terminalAgentSnapshot(['cursor']))));
    await waitFor(() => expect(rawDispatch).toHaveBeenCalledTimes(1));
    await act(async () => first.resolve(result(terminalAgentSnapshot(['claude']))));

    expect(rawDispatch).toHaveBeenCalledTimes(1);
    expect(rawDispatch).toHaveBeenCalledWith('cursor', input);
    expect(recordHandoff).toHaveBeenCalledExactlyOnceWith({
      target: 'claude-code',
      host: 'web',
      outcome: 'error',
      reason: 'superseded',
      ts: expect.any(String),
    });
  });

  test('a superseded stalled read cannot later bypass readiness or launch its destination', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = deferred<ApplyAgentConnectionsResult>();
    const applyConnections = vi
      .fn<() => Promise<ApplyAgentConnectionsResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(result(terminalAgentSnapshot(['cursor'])));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    const firstOutcome = vi.fn();
    renderGate(
      applyConnections,
      <>
        <GateHarness rawDispatch={rawDispatch} onOutcome={firstOutcome} />
        <GateHarness rawDispatch={rawDispatch} target="cursor" />
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open cursor' }));
    await act(async () => {});
    expect(firstOutcome).toHaveBeenCalledWith({ ok: false, reason: 'superseded' });
    expect(rawDispatch).toHaveBeenCalledExactlyOnceWith('cursor', input);
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    await act(async () => first.resolve(result(terminalAgentSnapshot(['claude']))));

    expect(rawDispatch).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test('a rejected stale check does not warn about bypassing readiness', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = deferred<ApplyAgentConnectionsResult>();
    const applyConnections = vi
      .fn<() => Promise<ApplyAgentConnectionsResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(result(terminalAgentSnapshot(['cursor'])));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(
      applyConnections,
      <>
        <GateHarness rawDispatch={rawDispatch} />
        <GateHarness rawDispatch={rawDispatch} target="cursor" />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open cursor' }));
    await waitFor(() => expect(rawDispatch).toHaveBeenCalledWith('cursor', input));
    await act(async () => first.reject(new Error('offline')));

    expect(warn).not.toHaveBeenCalled();
    expect(rawDispatch).toHaveBeenCalledTimes(1);
    expect(recordHandoff).toHaveBeenCalledExactlyOnceWith({
      target: 'claude-code',
      host: 'web',
      outcome: 'error',
      reason: 'superseded',
      ts: expect.any(String),
    });
  });

  test('a newer request supersedes an in-flight setup save', async () => {
    const save = deferred<ApplyAgentConnectionsResult>();
    const applyConnections = vi
      .fn<() => Promise<ApplyAgentConnectionsResult>>()
      .mockResolvedValueOnce(result(terminalAgentSnapshot()))
      .mockReturnValueOnce(save.promise)
      .mockResolvedValueOnce(result(terminalAgentSnapshot(['cursor'])));
    const rawDispatch = vi.fn(async () => ({ ok: true as const }));
    renderGate(
      applyConnections,
      <>
        <GateHarness rawDispatch={rawDispatch} />
        <GateHarness rawDispatch={rawDispatch} target="cursor" />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open claude-code' }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(applyConnections).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Open cursor', hidden: true }));

    await waitFor(() => expect(rawDispatch).toHaveBeenCalledWith('cursor', input));
    await act(async () => save.resolve(result(terminalAgentSnapshot(['claude']))));

    expect(rawDispatch).toHaveBeenCalledTimes(1);
  });
});

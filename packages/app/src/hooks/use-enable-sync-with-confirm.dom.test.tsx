import type { SyncMode } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

const toastErrors: string[] = [];
vi.doMock('sonner', () => ({
  toast: {
    error: (message: string) => toastErrors.push(message),
  },
}));

let projectLocalBinding: null | {
  patch: (patch: unknown) => { ok: true } | { ok: false; error: unknown };
} = null;
let projectBinding: null | {
  patch: (patch: unknown) => { ok: true } | { ok: false; error: unknown };
} = null;

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({ projectBinding, projectLocalBinding }),
}));

type Writer = ((enabled: boolean) => { ok: true } | { ok: false; error: string }) | null;
type ConfirmState = {
  confirmOpen: boolean;
  setConfirmOpen: (open: boolean) => void;
  onToggleRequest: (next: boolean) => void;
  onConfirm: () => void;
};
let hooks: Awaited<typeof import('./use-enable-sync-with-confirm')> | null = null;
let latestConfirmState: ConfirmState | null = null;
let latestWriter: Writer | undefined;

async function loadHooks() {
  hooks ??= await import('./use-enable-sync-with-confirm');
  return hooks;
}

function ConfirmProbe({ writer, onEnabled }: { writer: Writer; onEnabled?: () => void }) {
  if (!hooks) throw new Error('hooks not loaded');
  latestConfirmState = hooks.useEnableSyncWithConfirm(
    writer,
    onEnabled ? { onEnabled } : undefined,
  );
  return <div data-testid="confirm-open">{String(latestConfirmState.confirmOpen)}</div>;
}

function WriterProbe({ children: _children }: { children?: ReactNode }) {
  if (!hooks) throw new Error('hooks not loaded');
  latestWriter = hooks.useSyncEnabledWriter();
  return <div data-testid="writer-present">{String(latestWriter !== null)}</div>;
}

type ModeWriter = ((mode: SyncMode) => { ok: true } | { ok: false; error: string }) | null;
let latestModeWriter: ModeWriter | undefined;

function ModeWriterProbe() {
  if (!hooks) throw new Error('hooks not loaded');
  latestModeWriter = hooks.useSyncModeWriter();
  return <div data-testid="mode-writer-present">{String(latestModeWriter !== null)}</div>;
}

type DefaultWriter =
  | ((next: boolean | SyncMode | null) => { ok: true } | { ok: false; error: string })
  | null;
let latestDefaultWriter: DefaultWriter | undefined;

function DefaultWriterProbe() {
  if (!hooks) throw new Error('hooks not loaded');
  latestDefaultWriter = hooks.useSyncDefaultWriter();
  return <div data-testid="default-writer-present">{String(latestDefaultWriter !== null)}</div>;
}

type ModeSelectionState = {
  confirmOpen: boolean;
  pendingMode: 'follow' | 'full' | null;
  onModeSelect: (next: SyncMode) => void;
  onConfirm: () => void;
};
let latestModeSelection: ModeSelectionState | null = null;

function ModeSelectionProbe({
  writer,
  currentMode,
}: {
  writer: ModeWriter;
  currentMode: SyncMode;
}) {
  if (!hooks) throw new Error('hooks not loaded');
  latestModeSelection = hooks.useSyncModeSelection(writer, currentMode);
  return (
    <div data-testid="mode-selection">
      {String(latestModeSelection.confirmOpen)}:{String(latestModeSelection.pendingMode)}
    </div>
  );
}

describe('useEnableSyncWithConfirm runtime behavior', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    cleanup();
    latestConfirmState = null;
    latestWriter = undefined;
    latestModeWriter = undefined;
    latestDefaultWriter = undefined;
    latestModeSelection = null;
    projectLocalBinding = null;
    projectBinding = null;
    toastErrors.length = 0;
    consoleErrorSpy?.mockRestore();
  });

  test('exports the hook and every writer adapter', async () => {
    const mod = await loadHooks();
    expect(typeof mod.useEnableSyncWithConfirm).toBe('function');
    expect(typeof mod.useSyncEnabledWriter).toBe('function');
    expect(typeof mod.useSyncModeWriter).toBe('function');
    expect(typeof mod.useSyncDefaultWriter).toBe('function');
  });

  test('off to on opens confirmation and writes true only after confirm', async () => {
    await loadHooks();
    const writes: boolean[] = [];
    const writer: Writer = (enabled) => {
      writes.push(enabled);
      return { ok: true };
    };
    render(<ConfirmProbe writer={writer} />);

    await act(async () => {
      latestConfirmState?.onToggleRequest(true);
    });
    expect(screen.getByTestId('confirm-open').textContent).toBe('true');
    expect(writes).toEqual([]);

    await act(async () => {
      latestConfirmState?.onConfirm();
    });
    expect(writes).toEqual([true]);
    expect(screen.getByTestId('confirm-open').textContent).toBe('false');
  });

  test('on to off commits immediately without opening confirmation', async () => {
    await loadHooks();
    const writes: boolean[] = [];
    const writer: Writer = (enabled) => {
      writes.push(enabled);
      return { ok: true };
    };
    render(<ConfirmProbe writer={writer} />);

    await act(async () => {
      latestConfirmState?.onToggleRequest(false);
    });

    expect(writes).toEqual([false]);
    expect(screen.getByTestId('confirm-open').textContent).toBe('false');
  });

  test('confirm keeps the dialog open when enabling fails', async () => {
    await loadHooks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const writer: Writer = () => ({ ok: false, error: 'branch is protected' });
    render(<ConfirmProbe writer={writer} />);

    await act(async () => {
      latestConfirmState?.onToggleRequest(true);
      latestConfirmState?.onConfirm();
    });

    expect(screen.getByTestId('confirm-open').textContent).toBe('true');
    expect(toastErrors).toEqual(['Failed to enable sync — branch is protected']);
  });

  test('fires opts.onEnabled once, only after a successful confirm', async () => {
    await loadHooks();
    let enabledCalls = 0;
    const writer: Writer = () => ({ ok: true });
    render(<ConfirmProbe writer={writer} onEnabled={() => enabledCalls++} />);

    await act(async () => {
      latestConfirmState?.onToggleRequest(true);
    });
    expect(enabledCalls).toBe(0); // not until the user confirms

    await act(async () => {
      latestConfirmState?.onConfirm();
    });
    expect(enabledCalls).toBe(1);
  });

  test('does not fire opts.onEnabled when the enable write fails', async () => {
    await loadHooks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let enabledCalls = 0;
    const writer: Writer = () => ({ ok: false, error: 'branch is protected' });
    render(<ConfirmProbe writer={writer} onEnabled={() => enabledCalls++} />);

    await act(async () => {
      latestConfirmState?.onToggleRequest(true);
      latestConfirmState?.onConfirm();
    });

    expect(enabledCalls).toBe(0);
    // Confirm dialog stays open on failure so the user can retry.
    expect(screen.getByTestId('confirm-open').textContent).toBe('true');
  });
});

describe('useSyncEnabledWriter runtime behavior', () => {
  afterEach(() => {
    cleanup();
    latestWriter = undefined;
    projectLocalBinding = null;
  });

  test('returns null until the project-local binding mounts', async () => {
    await loadHooks();
    projectLocalBinding = null;
    render(<WriterProbe />);

    expect(screen.getByTestId('writer-present').textContent).toBe('false');
    expect(latestWriter).toBeNull();
  });

  test('patches both autoSync.mode and the legacy enabled leaf so a set mode cannot mask the enable', async () => {
    await loadHooks();
    const patches: unknown[] = [];
    projectLocalBinding = {
      patch: (patch: unknown) => {
        patches.push(patch);
        return { ok: true };
      },
    };
    render(<WriterProbe />);

    // Enabling must write mode:'full' (the value resolveLocalAutoSyncMode reads
    // first), not just enabled:true — otherwise a machine that previously set
    // mode:'off' would ignore the enable.
    expect(latestWriter?.(true)).toEqual({ ok: true });
    expect(latestWriter?.(false)).toEqual({ ok: true });
    expect(patches).toEqual([
      { autoSync: { mode: 'full', enabled: true } },
      { autoSync: { mode: 'off', enabled: false } },
    ]);
  });

  test('wraps binding errors into a string result for toast rendering', async () => {
    await loadHooks();
    projectLocalBinding = {
      patch: () => ({ ok: false, error: { code: 'WRITE_ERROR', detail: 'disk denied' } }),
    };
    render(<WriterProbe />);

    expect(latestWriter?.(false)).toEqual({
      ok: false,
      error: 'Failed to write config file: disk denied',
    });
  });
});

describe('useSyncModeWriter runtime behavior', () => {
  afterEach(() => {
    cleanup();
    latestModeWriter = undefined;
    projectLocalBinding = null;
  });

  test('returns null until the project-local binding mounts', async () => {
    await loadHooks();
    projectLocalBinding = null;
    render(<ModeWriterProbe />);

    expect(screen.getByTestId('mode-writer-present').textContent).toBe('false');
    expect(latestModeWriter).toBeNull();
  });

  test('patches autoSync.mode on the project-local binding', async () => {
    await loadHooks();
    const patches: unknown[] = [];
    projectLocalBinding = {
      patch: (patch: unknown) => {
        patches.push(patch);
        return { ok: true };
      },
    };
    render(<ModeWriterProbe />);

    expect(latestModeWriter?.('follow')).toEqual({ ok: true });
    // Writes the mode AND clears the legacy `enabled` flag so an older app
    // can't read a stale toggle and push for a mode the user switched away from.
    expect(patches).toEqual([{ autoSync: { mode: 'follow', enabled: null } }]);
  });

  test('wraps binding errors into a string result for toast rendering', async () => {
    await loadHooks();
    projectLocalBinding = {
      patch: () => ({ ok: false, error: { code: 'WRITE_ERROR', detail: 'disk denied' } }),
    };
    render(<ModeWriterProbe />);

    expect(latestModeWriter?.('full')).toEqual({
      ok: false,
      error: 'Failed to write config file: disk denied',
    });
  });
});

describe('useSyncDefaultWriter runtime behavior', () => {
  afterEach(() => {
    cleanup();
    latestDefaultWriter = undefined;
    projectBinding = null;
    projectLocalBinding = null;
  });

  test('returns null until the committed project binding mounts', async () => {
    await loadHooks();
    projectBinding = null;
    render(<DefaultWriterProbe />);

    expect(screen.getByTestId('default-writer-present').textContent).toBe('false');
    expect(latestDefaultWriter).toBeNull();
  });

  test('patches autoSync.default on the COMMITTED project binding, not project-local', async () => {
    await loadHooks();
    const committedPatches: unknown[] = [];
    const localPatches: unknown[] = [];
    projectBinding = {
      patch: (patch: unknown) => {
        committedPatches.push(patch);
        return { ok: true };
      },
    };
    // A project-local binding is also mounted: the scope-collision regression
    // (targeting projectLocalBinding instead of projectBinding) would land the
    // write here, silently writing per-machine config instead of committed.
    projectLocalBinding = {
      patch: (patch: unknown) => {
        localPatches.push(patch);
        return { ok: true };
      },
    };
    render(<DefaultWriterProbe />);

    expect(latestDefaultWriter?.(false)).toEqual({ ok: true });
    expect(committedPatches).toEqual([{ autoSync: { default: false } }]);
    expect(localPatches).toEqual([]);

    // `null` clears the committed key (RFC 7396 delete) → reset to ask.
    expect(latestDefaultWriter?.(null)).toEqual({ ok: true });
    expect(committedPatches).toEqual([
      { autoSync: { default: false } },
      { autoSync: { default: null } },
    ]);
    expect(localPatches).toEqual([]);
  });

  test('patches a widened mode-string default (committed pull seed)', async () => {
    await loadHooks();
    const committedPatches: unknown[] = [];
    projectBinding = {
      patch: (patch: unknown) => {
        committedPatches.push(patch);
        return { ok: true };
      },
    };
    render(<DefaultWriterProbe />);

    expect(latestDefaultWriter?.('follow')).toEqual({ ok: true });
    expect(committedPatches).toEqual([{ autoSync: { default: 'follow' } }]);
  });

  test('wraps binding errors into a string result for toast rendering', async () => {
    await loadHooks();
    projectBinding = {
      patch: () => ({ ok: false, error: { code: 'WRITE_ERROR', detail: 'disk denied' } }),
    };
    render(<DefaultWriterProbe />);

    expect(latestDefaultWriter?.(true)).toEqual({
      ok: false,
      error: 'Failed to write config file: disk denied',
    });
  });
});

describe('useSyncModeSelection runtime behavior', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    cleanup();
    latestModeSelection = null;
    projectLocalBinding = null;
    toastErrors.length = 0;
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = undefined;
  });

  test('selecting off commits immediately without a confirmation', async () => {
    await loadHooks();
    const writes: SyncMode[] = [];
    const writer: ModeWriter = (mode) => {
      writes.push(mode);
      return { ok: true };
    };
    render(<ModeSelectionProbe writer={writer} currentMode="full" />);

    await act(async () => {
      latestModeSelection?.onModeSelect('off');
    });

    expect(writes).toEqual(['off']);
    expect(screen.getByTestId('mode-selection').textContent).toBe('false:null');
  });

  test('selecting pull opens the confirmation and writes only after confirm', async () => {
    await loadHooks();
    const writes: SyncMode[] = [];
    const writer: ModeWriter = (mode) => {
      writes.push(mode);
      return { ok: true };
    };
    render(<ModeSelectionProbe writer={writer} currentMode="off" />);

    await act(async () => {
      latestModeSelection?.onModeSelect('follow');
    });
    expect(screen.getByTestId('mode-selection').textContent).toBe('true:follow');
    expect(writes).toEqual([]);

    await act(async () => {
      latestModeSelection?.onConfirm();
    });
    expect(writes).toEqual(['follow']);
    expect(screen.getByTestId('mode-selection').textContent).toBe('false:follow');
  });

  test('escalating pull to full confirms with the full variant', async () => {
    await loadHooks();
    const writes: SyncMode[] = [];
    const writer: ModeWriter = (mode) => {
      writes.push(mode);
      return { ok: true };
    };
    render(<ModeSelectionProbe writer={writer} currentMode="follow" />);

    await act(async () => {
      latestModeSelection?.onModeSelect('full');
    });
    expect(screen.getByTestId('mode-selection').textContent).toBe('true:full');

    await act(async () => {
      latestModeSelection?.onConfirm();
    });
    expect(writes).toEqual(['full']);
  });

  test('re-selecting the current mode is a no-op', async () => {
    await loadHooks();
    const writes: SyncMode[] = [];
    const writer: ModeWriter = (mode) => {
      writes.push(mode);
      return { ok: true };
    };
    render(<ModeSelectionProbe writer={writer} currentMode="follow" />);

    await act(async () => {
      latestModeSelection?.onModeSelect('follow');
    });

    expect(writes).toEqual([]);
    expect(screen.getByTestId('mode-selection').textContent).toBe('false:null');
  });

  test('a failed confirm keeps the dialog open and toasts', async () => {
    await loadHooks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const writer: ModeWriter = () => ({ ok: false, error: 'branch is protected' });
    render(<ModeSelectionProbe writer={writer} currentMode="off" />);

    // Two clicks in the real UI (select, re-render shows the dialog, then
    // confirm) — split acts so `onConfirm` reads the committed pendingMode.
    await act(async () => {
      latestModeSelection?.onModeSelect('full');
    });
    await act(async () => {
      latestModeSelection?.onConfirm();
    });

    expect(screen.getByTestId('mode-selection').textContent).toBe('true:full');
    expect(toastErrors).toEqual(['Failed to update sync mode — branch is protected']);
  });
});

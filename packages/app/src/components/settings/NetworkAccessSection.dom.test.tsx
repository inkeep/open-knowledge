import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type PatchResult = { ok: true } | { ok: false; error: unknown };
interface FakeBinding {
  patch: (p: unknown) => PatchResult;
}

let projectConfig: {
  server?: { externalUrl?: string; port?: number; allowExternal?: boolean };
} | null;
let projectSynced: boolean;
let projectBinding: FakeBinding | null;
let projectLocalConfig: { server?: { allowExternal?: boolean } } | null;
let projectLocalSynced: boolean;
let projectLocalBinding: FakeBinding | null;

const projectPatchCalls: unknown[] = [];
const localPatchCalls: unknown[] = [];
const patchOrder: Array<'project' | 'local'> = [];
const restartCalls: unknown[] = [];
const toastErrors: unknown[] = [];
type RestartOutcome = { ok: true } | { ok: false; message: string };
let restartImpl: (bridge: unknown) => Promise<RestartOutcome>;

vi.doMock('@lingui/react/macro', () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((out, part, i) => `${out}${part}${values[i] ?? ''}`, ''),
  }),
  Trans: ({ children }: { children: import('react').ReactNode }) => children,
}));

vi.doMock('sonner', () => ({ toast: { error: (m: unknown) => toastErrors.push(m) } }));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectConfig,
    projectSynced,
    projectBinding,
    projectLocalConfig,
    projectLocalSynced,
    projectLocalBinding,
  }),
}));

vi.doMock('@/lib/restart-collab-server', () => ({
  restartCollabServer: (bridge: unknown) => {
    restartCalls.push(bridge);
    return restartImpl(bridge);
  },
}));

const { NetworkAccessSection } = await import('./NetworkAccessSection');

function makeBinding(kind: 'project' | 'local', calls: unknown[]): FakeBinding {
  return {
    patch: (p) => {
      calls.push(p);
      patchOrder.push(kind);
      return { ok: true };
    },
  };
}

function exposeToggle() {
  return screen.getByTestId('settings-network-expose-toggle') as HTMLButtonElement;
}
function applyButton() {
  return screen.getByTestId('settings-network-apply') as HTMLButtonElement;
}

beforeEach(() => {
  projectConfig = { server: {} };
  projectSynced = true;
  projectBinding = makeBinding('project', projectPatchCalls);
  projectLocalConfig = { server: {} };
  projectLocalSynced = true;
  projectLocalBinding = makeBinding('local', localPatchCalls);
  projectPatchCalls.length = 0;
  localPatchCalls.length = 0;
  patchOrder.length = 0;
  restartCalls.length = 0;
  toastErrors.length = 0;
  restartImpl = async () => ({ ok: true });
  (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = {};
});

afterEach(() => {
  cleanup();
  (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = undefined;
});

describe('NetworkAccessSection', () => {
  test('a committed allowExternal never shows as enabled (clone-leak: read consent from project-local only)', () => {
    projectConfig = { server: { allowExternal: true, externalUrl: 'https://leak.example.com' } };
    projectLocalConfig = { server: {} };
    render(<NetworkAccessSection />);
    expect(exposeToggle().getAttribute('aria-checked')).toBe('false');
  });

  test('a project-local allowExternal shows as enabled', () => {
    projectLocalConfig = { server: { allowExternal: true } };
    render(<NetworkAccessSection />);
    expect(exposeToggle().getAttribute('aria-checked')).toBe('true');
  });

  test('shows a hosting-active indicator when exposure is enabled and the port is bound', () => {
    projectLocalConfig = { server: { allowExternal: true } };
    (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = {
      config: { apiOrigin: 'http://localhost:24550' },
    };
    render(<NetworkAccessSection />);
    expect(screen.queryByTestId('settings-network-serving')).not.toBeNull();
  });

  test('enabling writes the scope split (origin+port → project, consent → project-local) and restarts', async () => {
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    await userEvent.type(
      screen.getByTestId('settings-network-origin'),
      'https://box.tailnet.ts.net',
    );
    await userEvent.click(applyButton());
    const confirm = await screen.findByTestId('settings-network-confirm-apply');
    await userEvent.click(confirm);

    await waitFor(() => expect(restartCalls).toHaveLength(1));
    expect(projectPatchCalls).toEqual([
      { server: { externalUrl: 'https://box.tailnet.ts.net', port: 24550 } },
    ]);
    expect(localPatchCalls).toEqual([{ server: { allowExternal: true } }]);
    expect(patchOrder).toEqual(['project', 'local']);
  });

  test('disabling drops consent first, then clears the origin, and restarts (no confirm)', async () => {
    projectConfig = { server: { externalUrl: 'https://box.tailnet.ts.net', port: 24550 } };
    projectLocalConfig = { server: { allowExternal: true } };
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    await userEvent.click(applyButton());

    await waitFor(() => expect(restartCalls).toHaveLength(1));
    expect(localPatchCalls).toEqual([{ server: { allowExternal: false } }]);
    expect(projectPatchCalls).toEqual([{ server: { externalUrl: null, port: 24550 } }]);
    expect(patchOrder).toEqual(['local', 'project']);
  });

  test('an invalid origin blocks apply — no writes, no restart', async () => {
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    await userEvent.type(screen.getByTestId('settings-network-origin'), 'not-a-url');
    await userEvent.click(applyButton());

    expect(screen.getByTestId('settings-network-origin-error')).toBeTruthy();
    expect(projectPatchCalls).toHaveLength(0);
    expect(localPatchCalls).toHaveLength(0);
    expect(restartCalls).toHaveLength(0);
  });

  test('apply is disabled until both bindings have synced', () => {
    projectSynced = false;
    render(<NetworkAccessSection />);
    expect(applyButton().disabled).toBe(true);
    expect(exposeToggle().disabled).toBe(true);
  });

  test('apply is disabled when a binding is still null even if synced flags are true', () => {
    projectBinding = null;
    render(<NetworkAccessSection />);
    expect(applyButton().disabled).toBe(true);
  });

  test('apply is disabled when the project-local binding is null (independent conjunct)', () => {
    projectLocalBinding = null;
    render(<NetworkAccessSection />);
    expect(applyButton().disabled).toBe(true);
  });

  test('apply is disabled until the project-local layer has synced', () => {
    projectLocalSynced = false;
    render(<NetworkAccessSection />);
    expect(applyButton().disabled).toBe(true);
    expect(exposeToggle().disabled).toBe(true);
  });

  test('a pinned port the server did not bind surfaces a warning and re-enables apply', async () => {
    projectConfig = { server: { port: 24550 } };
    (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = {
      config: { apiOrigin: 'http://localhost:51234' },
    };
    render(<NetworkAccessSection />);
    expect(screen.getByTestId('settings-network-port-inuse')).toBeTruthy();
    expect(applyButton().disabled).toBe(false);

    await userEvent.click(applyButton());
    await waitFor(() => expect(restartCalls).toHaveLength(1));
  });

  test('no warning when the bound port matches the configured port', () => {
    projectConfig = { server: { port: 24550 } };
    (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = {
      config: { apiOrigin: 'http://localhost:24550' },
    };
    render(<NetworkAccessSection />);
    expect(screen.queryByTestId('settings-network-port-inuse')).toBeNull();
  });

  test('preflight probe flags a typed fixed port that is already in use', async () => {
    (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = {
      config: { apiOrigin: 'http://localhost:24550' },
      remoteAccess: { probePort: async () => false },
    };
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    const input = screen.getByTestId('settings-network-port-input');
    await userEvent.clear(input);
    await userEvent.type(input, '24560');
    await waitFor(() =>
      expect(screen.queryByTestId('settings-network-port-unavailable')).not.toBeNull(),
    );
    expect(screen.queryByTestId('settings-network-port-available')).toBeNull();
    expect(applyButton().disabled).toBe(true);
  });

  test('preflight probe confirms a free typed fixed port', async () => {
    (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = {
      config: { apiOrigin: 'http://localhost:24550' },
      remoteAccess: { probePort: async () => true },
    };
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    const input = screen.getByTestId('settings-network-port-input');
    await userEvent.clear(input);
    await userEvent.type(input, '24560');
    await waitFor(() =>
      expect(screen.queryByTestId('settings-network-port-available')).not.toBeNull(),
    );
    expect(screen.queryByTestId('settings-network-port-unavailable')).toBeNull();
  });

  test('a stale port verdict clears immediately when the draft changes', async () => {
    (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = {
      config: { apiOrigin: 'http://localhost:24550' },
      remoteAccess: { probePort: async (p: number) => p === 24580 },
    };
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    const input = screen.getByTestId('settings-network-port-input');
    await userEvent.clear(input);
    await userEvent.type(input, '24580');
    await waitFor(() =>
      expect(screen.queryByTestId('settings-network-port-available')).not.toBeNull(),
    );
    await userEvent.clear(input);
    await userEvent.type(input, '24575');
    expect(screen.queryByTestId('settings-network-port-available')).toBeNull();
    await waitFor(() =>
      expect(screen.queryByTestId('settings-network-port-unavailable')).not.toBeNull(),
    );
  });

  test('the port we are already bound to counts as available even when the probe says taken', async () => {
    (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = {
      config: { apiOrigin: 'http://localhost:24560' },
      remoteAccess: { probePort: async () => false },
    };
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    await userEvent.type(
      screen.getByTestId('settings-network-origin'),
      'https://box.tailnet.ts.net',
    );
    const input = screen.getByTestId('settings-network-port-input');
    await userEvent.clear(input);
    await userEvent.type(input, '24560');
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    expect(screen.queryByTestId('settings-network-port-unavailable')).toBeNull();
  });

  test('an out-of-range port blocks apply — error shown, no writes, no restart', async () => {
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    await userEvent.type(
      screen.getByTestId('settings-network-origin'),
      'https://box.tailnet.ts.net',
    );
    const input = screen.getByTestId('settings-network-port-input');
    await userEvent.clear(input);
    await userEvent.type(input, '99999');
    await userEvent.click(applyButton());

    expect(screen.getByTestId('settings-network-port-error')).toBeTruthy();
    expect(projectPatchCalls).toHaveLength(0);
    expect(localPatchCalls).toHaveLength(0);
    expect(restartCalls).toHaveLength(0);
  });

  test('a failed config patch surfaces an error toast and does not restart', async () => {
    projectLocalBinding = {
      patch: () => ({ ok: false, error: { code: 'SCHEMA_INVALID', issues: [] } }),
    };
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    await userEvent.type(screen.getByTestId('settings-network-origin'), 'https://box.example.com');
    await userEvent.click(applyButton());
    const confirm = await screen.findByTestId('settings-network-confirm-apply');
    await userEvent.click(confirm);

    await waitFor(() => expect(toastErrors.length).toBeGreaterThan(0));
    expect(restartCalls).toHaveLength(0);
    expect(applyButton().disabled).toBe(false);
  });

  test('disable-path second-write failure still restarts to stop exposure', async () => {
    projectConfig = { server: { externalUrl: 'https://box.example.com', port: 24550 } };
    projectLocalConfig = { server: { allowExternal: true } };
    projectBinding = {
      patch: () => ({ ok: false, error: { code: 'SCHEMA_INVALID', issues: [] } }),
    };
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    await userEvent.click(applyButton());

    await waitFor(() => expect(restartCalls).toHaveLength(1));
    expect(localPatchCalls).toEqual([{ server: { allowExternal: false } }]);
    expect(toastErrors.some((m) => String(m).includes('exposure is turning off'))).toBe(true);
  });

  test('a first-write failure in the enable path skips the consent write (fail-safe order)', async () => {
    projectBinding = {
      patch: () => ({ ok: false, error: { code: 'SCHEMA_INVALID', issues: [] } }),
    };
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    await userEvent.type(screen.getByTestId('settings-network-origin'), 'https://box.example.com');
    await userEvent.click(applyButton());
    const confirm = await screen.findByTestId('settings-network-confirm-apply');
    await userEvent.click(confirm);

    await waitFor(() => expect(toastErrors.length).toBeGreaterThan(0));
    expect(localPatchCalls).toHaveLength(0);
    expect(restartCalls).toHaveLength(0);
  });

  test('a resolved restart failure toasts and re-enables apply', async () => {
    restartImpl = async () => ({ ok: false, message: 'could not restart' });
    projectLocalConfig = { server: { allowExternal: true } };
    projectConfig = { server: { externalUrl: 'https://box.example.com', port: 24550 } };
    render(<NetworkAccessSection />);
    await userEvent.click(screen.getByTestId('settings-network-port-input'));
    await userEvent.clear(screen.getByTestId('settings-network-port-input'));
    await userEvent.type(screen.getByTestId('settings-network-port-input'), '24551');
    await userEvent.click(applyButton());

    await waitFor(() => expect(toastErrors).toContain('could not restart'));
    expect(applyButton().disabled).toBe(false);
  });

  test('a rejected restart (window torn down) re-enables apply without an unhandled rejection', async () => {
    restartImpl = () => Promise.reject(new Error('window destroyed'));
    projectLocalConfig = { server: { allowExternal: true } };
    projectConfig = { server: { externalUrl: 'https://box.example.com', port: 24550 } };
    render(<NetworkAccessSection />);
    await userEvent.clear(screen.getByTestId('settings-network-port-input'));
    await userEvent.type(screen.getByTestId('settings-network-port-input'), '24551');
    await userEvent.click(applyButton());

    await waitFor(() => expect(restartCalls).toHaveLength(1));
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    expect(toastErrors.some((m) => String(m).includes('restart the server'))).toBe(false);
  });

  test('a genuine restart IPC failure surfaces a toast (not a silent re-enable)', async () => {
    restartImpl = () => Promise.reject(new Error('unexpected main-side error'));
    projectLocalConfig = { server: { allowExternal: true } };
    projectConfig = { server: { externalUrl: 'https://box.example.com', port: 24550 } };
    render(<NetworkAccessSection />);
    await userEvent.clear(screen.getByTestId('settings-network-port-input'));
    await userEvent.type(screen.getByTestId('settings-network-port-input'), '24551');
    await userEvent.click(applyButton());
    await waitFor(() =>
      expect(toastErrors.some((m) => String(m).includes('restart the server'))).toBe(true),
    );
    expect(applyButton().disabled).toBe(false);
  });

  test('a valid URL with a non-http(s) scheme is rejected without writing', async () => {
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    await userEvent.type(screen.getByTestId('settings-network-origin'), 'ftp://notes.example.com');
    await userEvent.click(applyButton());
    expect(screen.getByTestId('settings-network-origin-error')).toBeTruthy();
    expect(projectPatchCalls).toHaveLength(0);
  });

  test('switching from a committed fixed port to Automatic makes Apply dirty and writes port: null', async () => {
    projectConfig = { server: { port: 24550 } };
    render(<NetworkAccessSection />);
    expect(applyButton().disabled).toBe(true);
    await userEvent.click(screen.getByTestId('settings-network-port-auto'));
    expect(applyButton().disabled).toBe(false);
    await userEvent.click(applyButton());
    await waitFor(() => expect(restartCalls).toHaveLength(1));
    expect(projectPatchCalls).toEqual([{ server: { externalUrl: null, port: null } }]);
  });

  test('cancelling the enable confirmation writes nothing and does not restart', async () => {
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    await userEvent.type(
      screen.getByTestId('settings-network-origin'),
      'https://box.tailnet.ts.net',
    );
    await userEvent.click(applyButton());
    await userEvent.click(await screen.findByTestId('settings-network-confirm-cancel'));

    expect(projectPatchCalls).toHaveLength(0);
    expect(localPatchCalls).toHaveLength(0);
    expect(restartCalls).toHaveLength(0);
  });

  test('disabling exposure is never blocked by a taken fixed port (recovery path)', async () => {
    projectLocalConfig = { server: { allowExternal: true } };
    projectConfig = { server: { externalUrl: 'https://box.example.com', port: 24550 } };
    (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = {
      config: { apiOrigin: 'http://localhost:51234' },
      remoteAccess: { probePort: async () => false },
    };
    render(<NetworkAccessSection />);
    await waitFor(() => expect(applyButton().disabled).toBe(true));
    await userEvent.click(exposeToggle());
    await waitFor(() => expect(applyButton().disabled).toBe(false));
  });
});

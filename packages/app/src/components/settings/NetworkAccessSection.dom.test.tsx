/**
 * Behavioral tests for Settings → This project → Network access.
 *
 * The system boundaries (the two CRDT-backed config bindings, the desktop
 * restart bridge) are mocked; the real shadcn Switch / Input / RadioGroup /
 * Button / AlertDialog render. The load-bearing assertions are the scope-split
 * writes — consent to the project-LOCAL binding, origin + port to the project
 * binding — and that a committed `allowExternal` never shows as enabled.
 */
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
    // A committed `allowExternal: true` (as a clone would carry) must stay inert
    // in the UI — the pane reads consent only from the project-local layer, so a
    // regression that also OR'd in the committed value would flip this to true.
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

  test('enabling writes the scope split (origin+port → project, consent → project-local) and restarts', async () => {
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle());
    await userEvent.type(
      screen.getByTestId('settings-network-origin'),
      'https://box.tailnet.ts.net',
    );
    await userEvent.click(applyButton());
    // Off→on consent transition is gated by a confirmation.
    const confirm = await screen.findByTestId('settings-network-confirm-apply');
    await userEvent.click(confirm);

    await waitFor(() => expect(restartCalls).toHaveLength(1));
    // Origin + pinned default port go to the committed project binding.
    expect(projectPatchCalls).toEqual([
      { server: { externalUrl: 'https://box.tailnet.ts.net', port: 24550 } },
    ]);
    // Consent goes to the project-local binding.
    expect(localPatchCalls).toEqual([{ server: { allowExternal: true } }]);
    // Fail-safe order: origin/port first, consent last.
    expect(patchOrder).toEqual(['project', 'local']);
  });

  test('disabling drops consent first, then clears the origin, and restarts (no confirm)', async () => {
    projectConfig = { server: { externalUrl: 'https://box.tailnet.ts.net', port: 24550 } };
    projectLocalConfig = { server: { allowExternal: true } };
    render(<NetworkAccessSection />);
    await userEvent.click(exposeToggle()); // on → off
    await userEvent.click(applyButton());

    await waitFor(() => expect(restartCalls).toHaveLength(1));
    expect(localPatchCalls).toEqual([{ server: { allowExternal: false } }]);
    expect(projectPatchCalls).toEqual([{ server: { externalUrl: null, port: 24550 } }]);
    // Fail-safe order: consent dropped first on disable.
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
    // Configured fixed port 24550, but the server actually bound 51234 (the
    // EADDRINUSE ephemeral fallback). The pane reads the bound port off the
    // bridge apiOrigin and flags the mismatch, and Apply is clickable again so
    // the user can retry after freeing the port — even though nothing is dirty.
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

    // Enable path writes project (origin/port) first, then the failing consent.
    await waitFor(() => expect(toastErrors.length).toBeGreaterThan(0));
    expect(restartCalls).toHaveLength(0);
    expect(applyButton().disabled).toBe(false);
  });

  test('a first-write failure in the enable path skips the consent write (fail-safe order)', async () => {
    // Enabling writes origin/port to the project binding FIRST, then consent to
    // the project-local binding. If the first write fails, the consent write
    // must be skipped so exposure is never armed with a broken origin/port — the
    // server stays loopback-only. projectLocalBinding is the tracking binding.
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
    // Consent (project-local) never written, and no restart.
    expect(localPatchCalls).toHaveLength(0);
    expect(restartCalls).toHaveLength(0);
  });

  test('a resolved restart failure toasts and re-enables apply', async () => {
    restartImpl = async () => ({ ok: false, message: 'could not restart' });
    projectLocalConfig = { server: { allowExternal: true } };
    projectConfig = { server: { externalUrl: 'https://box.example.com', port: 24550 } };
    render(<NetworkAccessSection />);
    // Toggle off → on an already-exposed field to make it dirty without a confirm.
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
  });
});

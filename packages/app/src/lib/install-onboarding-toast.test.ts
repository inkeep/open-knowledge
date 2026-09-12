import * as actualSonner from 'sonner';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge, OkOnboardingToastPayload } from '@/lib/desktop-bridge-types';

const toastError = vi.fn((_msg: string, _opts?: unknown) => 'error-id');
const toastSuccess = vi.fn((_msg: string, _opts?: unknown) => 'success-id');
vi.doMock('sonner', () => ({
  ...actualSonner,
  toast: Object.assign(
    vi.fn(() => {}),
    { error: toastError, success: toastSuccess, warning: vi.fn(), dismiss: vi.fn() },
  ),
}));

type ToastModule = typeof import('@/lib/install-onboarding-toast');
let installOnboardingToastListener: ToastModule['installOnboardingToastListener'];
beforeAll(async () => {
  ({ installOnboardingToastListener } = await import('@/lib/install-onboarding-toast'));
});

function makeBridge(): {
  bridge: OkDesktopBridge;
  fire: (payload: OkOnboardingToastPayload) => void;
} {
  let cb: ((payload: OkOnboardingToastPayload) => void) | null = null;
  const bridge = {
    onboarding: {
      onToast: (next: (payload: OkOnboardingToastPayload) => void) => {
        cb = next;
        return () => {};
      },
    },
  } as unknown as OkDesktopBridge;
  return { bridge, fire: (payload) => cb?.(payload) };
}

const lastError = () =>
  toastError.mock.calls.at(-1) as [string, { duration?: number; position?: string }] | undefined;

describe('startup-reclaim toast', () => {
  beforeEach(() => {
    toastError.mockClear();
    toastSuccess.mockClear();
  });

  test('a failed run names each agent with its reason and lists what was repaired', () => {
    const { bridge, fire } = makeBridge();
    installOnboardingToastListener({ bridge });
    fire({
      kind: 'startup-reclaim',
      mcp: {
        status: 'failed',
        failures: [{ editor: 'codex', reason: 'no-native-writer' }, { editor: 'cursor' }],
        repaired: ['claude'],
      },
      path: { status: 'none' },
    });
    const [message, opts] = lastError() ?? [];
    expect(message).toBe(
      'repaired MCP integration for Claude; MCP auto-repair failed for Codex, Cursor',
    );
    expect(opts?.description).toBe('Codex: no-native-writer');
    expect(opts?.duration).toBe(24 * 60 * 60 * 1000);
    expect(opts?.position).toBe('bottom-left');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  test('a failed run that names no agent falls back to the bare failure line', () => {
    const { bridge, fire } = makeBridge();
    installOnboardingToastListener({ bridge });
    fire({
      kind: 'startup-reclaim',
      mcp: { status: 'failed', failures: [] },
      path: { status: 'none' },
    });
    expect(lastError()?.[0]).toBe('MCP auto-repair failed');
    expect(lastError()?.[1]?.description).toBeUndefined();
  });

  test('a clean repair is a success toast naming the agents', () => {
    const { bridge, fire } = makeBridge();
    installOnboardingToastListener({ bridge });
    fire({
      kind: 'startup-reclaim',
      mcp: { status: 'repaired', editors: ['claude', 'cursor'] },
      path: { status: 'none' },
    });
    expect(toastSuccess.mock.calls.at(-1)?.[0]).toBe('repaired MCP integration for Claude, Cursor');
    expect(toastError).not.toHaveBeenCalled();
  });

  test('a PATH install alone is a sticky success toast carrying the summary', () => {
    const { bridge, fire } = makeBridge();
    installOnboardingToastListener({ bridge });
    fire({
      kind: 'startup-reclaim',
      mcp: { status: 'none' },
      path: { status: 'installed', summary: 'Added ok to your PATH' },
    });
    const [message, opts] = toastSuccess.mock.calls.at(-1) as [string, { duration?: number }];
    expect(message).toBe('Added ok to your PATH');
    expect(opts.duration).toBe(24 * 60 * 60 * 1000);
    expect(toastError).not.toHaveBeenCalled();
  });

  test('a failed PATH install is an error toast even when MCP was fine', () => {
    const { bridge, fire } = makeBridge();
    installOnboardingToastListener({ bridge });
    fire({
      kind: 'startup-reclaim',
      mcp: { status: 'repaired', editors: ['claude'] },
      path: { status: 'failed', summary: 'rc file is read-only' },
    });
    expect(lastError()?.[0]).toBe(
      'repaired MCP integration for Claude; PATH install failed: rc file is read-only',
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  test('a repaired MCP with no PATH work is a short success toast', () => {
    const { bridge, fire } = makeBridge();
    installOnboardingToastListener({ bridge });
    fire({
      kind: 'startup-reclaim',
      mcp: { status: 'repaired', editors: ['claude'] },
      path: { status: 'none' },
    });
    expect((toastSuccess.mock.calls.at(-1) as [string, { duration?: number }])[1].duration).toBe(
      4000,
    );
  });
});

describe('the other onboarding toasts', () => {
  beforeEach(() => {
    toastError.mockClear();
    toastSuccess.mockClear();
  });

  test('ancestor-promote names the project that was opened instead', () => {
    const { bridge, fire } = makeBridge();
    installOnboardingToastListener({ bridge });
    fire({ kind: 'ancestor-promote', ancestorPath: '/srv/notes' });
    expect(toastSuccess.mock.calls.at(-1)?.[0]).toBe(
      'Opened existing OpenKnowledge project at /srv/notes',
    );
  });

  test('git-root-promote names the root and the picked folder', () => {
    const { bridge, fire } = makeBridge();
    installOnboardingToastListener({ bridge });
    fire({ kind: 'git-root-promote', gitRoot: '/srv/repo', pickedPath: '/srv/repo/docs' });
    expect(toastSuccess.mock.calls.at(-1)?.[0]).toContain('Initialized OpenKnowledge at /srv/repo');
    expect(toastSuccess.mock.calls.at(-1)?.[0]).toContain('opened parent of docs');
  });

  test('sharing-refused-tracked is a sticky error carrying the remediation', () => {
    const { bridge, fire } = makeBridge();
    installOnboardingToastListener({ bridge });
    fire({
      kind: 'sharing-refused-tracked',
      tracked: ['.ok/config.yml'],
      remediation: 'Untrack the file first.',
    });
    const [message, opts] = lastError() as [string, { duration?: number; description?: string }];
    expect(message).toContain('1 OK file');
    expect(opts.description).toBe('Untrack the file first.');
    expect(opts.duration).toBe(24 * 60 * 60 * 1000);
  });
});

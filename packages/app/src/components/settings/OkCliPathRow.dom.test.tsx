import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  OkIntegrationsSetRequest,
  OkIntegrationsSetResult,
  OkIntegrationsStatus,
} from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const toastError = vi.fn(() => {});
vi.doMock('sonner', () => ({
  toast: { error: toastError, info: vi.fn(() => {}), success: vi.fn(() => {}) },
}));

const { OkCliPathRow } = await import('./OkCliPathRow');
const { TooltipProvider } = await import('@/components/ui/tooltip');

function statusWith(path: OkIntegrationsStatus['path']): OkIntegrationsStatus {
  return { available: true, editors: [], skills: [], path };
}

function installBridge(
  status: OkIntegrationsStatus,
  setResult?: (request: OkIntegrationsSetRequest) => OkIntegrationsSetResult,
) {
  const setCalls: OkIntegrationsSetRequest[] = [];
  const bridge = {
    integrations: {
      status: async () => status,
      setComponent: async (request: OkIntegrationsSetRequest) => {
        setCalls.push(request);
        return setResult ? setResult(request) : { ok: true as const, status };
      },
    },
  };
  Object.defineProperty(window, 'okDesktop', {
    value: bridge,
    configurable: true,
    writable: true,
  });
  return { setCalls };
}

function renderRow() {
  return render(
    <TooltipProvider>
      <OkCliPathRow />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  toastError.mockClear();
  // biome-ignore lint/suspicious/noExplicitAny: test-only global teardown.
  (window as any).okDesktop = undefined;
});

describe('OkCliPathRow', () => {
  test('reflects the installed state on disk and names the file it manages', async () => {
    installBridge(
      statusWith({ shellDetected: true, rcFilesToTouch: ['~/.zshrc'], installed: true }),
    );
    renderRow();

    const checkbox = await screen.findByTestId('ok-cli-path-checkbox');
    expect(checkbox.getAttribute('data-state')).toBe('checked');
    expect(screen.getByTestId('ok-cli-path-status').textContent).toContain('~/.zshrc');
  });

  test('checking it asks the host to install the shim', async () => {
    const { setCalls } = installBridge(
      statusWith({ shellDetected: true, rcFilesToTouch: ['~/.zshrc'], installed: false }),
    );
    renderRow();

    await userEvent.click(await screen.findByTestId('ok-cli-path-checkbox'));

    await waitFor(() => expect(setCalls).toHaveLength(1));
    expect(setCalls[0]).toEqual({ component: { kind: 'path' }, enabled: true });
  });

  test('unchecking it asks the host to remove the shim', async () => {
    const { setCalls } = installBridge(
      statusWith({ shellDetected: true, rcFilesToTouch: ['~/.zshrc'], installed: true }),
    );
    renderRow();

    await userEvent.click(await screen.findByTestId('ok-cli-path-checkbox'));

    await waitFor(() => expect(setCalls).toHaveLength(1));
    expect(setCalls[0]).toEqual({ component: { kind: 'path' }, enabled: false });
  });

  test('surfaces a refused apply instead of silently reverting the box', async () => {
    const status = statusWith({
      shellDetected: true,
      rcFilesToTouch: ['~/.zshrc'],
      installed: false,
    });
    installBridge(status, () => ({ ok: false as const, error: 'rc file is read-only', status }));
    renderRow();

    await userEvent.click(await screen.findByTestId('ok-cli-path-checkbox'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('rc file is read-only'));
  });

  test('renders nothing without the desktop bridge', async () => {
    renderRow();
    await waitFor(() => expect(screen.queryByTestId('ok-cli-path-row')).toBeNull());
  });

  test('renders nothing when there is no shell to add it to and nothing installed', async () => {
    installBridge(statusWith({ shellDetected: false, rcFilesToTouch: [], installed: false }));
    renderRow();
    await waitFor(() => expect(screen.queryByTestId('ok-cli-path-row')).toBeNull());
  });

  test('still offers removal when the shell went away but the block did not', async () => {
    installBridge(
      statusWith({ shellDetected: false, rcFilesToTouch: ['~/.zshrc'], installed: true }),
    );
    renderRow();

    const checkbox = await screen.findByTestId('ok-cli-path-checkbox');
    expect(checkbox.getAttribute('data-state')).toBe('checked');
  });
});

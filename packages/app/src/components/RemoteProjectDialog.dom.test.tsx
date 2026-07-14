import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OkDesktopBridge, OkSshMachine } from '@/lib/desktop-bridge-types';
import { RemoteProjectDialog } from './RemoteProjectDialog';

// Radix Dialog's focus trap reaches for DOM globals not promoted by the shared
// jsdom preload. Keep the shims local, matching the other dialog DOM tests.
type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}
type ElementPointerShims = Element & {
  hasPointerCapture?: () => boolean;
  releasePointerCapture?: () => void;
  scrollIntoView?: () => void;
};
const elementPrototype = Element.prototype as ElementPointerShims;
elementPrototype.hasPointerCapture ??= () => false;
elementPrototype.releasePointerCapture ??= () => {};
elementPrototype.scrollIntoView ??= () => {};

const machine: OkSshMachine = {
  id: 'machine-1',
  name: 'Staging',
  host: 'staging-box',
  port: 2222,
};

interface BridgeCalls {
  save: Array<{ id?: string; name: string; host: string; port?: number }>;
  remove: string[];
  test: string[];
  listDirectories: Array<{ machineId: string; path: string }>;
  open: Array<{ machineId: string; path: string }>;
}

function makeBridge(options?: {
  machines?: OkSshMachine[];
  testResult?: { ok: true } | { ok: false; error: string };
  openResult?: boolean;
}) {
  const calls: BridgeCalls = {
    save: [],
    remove: [],
    test: [],
    listDirectories: [],
    open: [],
  };
  const savedMachines = options?.machines ?? [machine];
  const bridge = {
    remote: {
      listMachines: async () => savedMachines,
      saveMachine: async (input: { id?: string; name: string; host: string; port?: number }) => {
        calls.save.push(input);
        return { id: 'machine-saved', ...input };
      },
      removeMachine: async (machineId: string) => {
        calls.remove.push(machineId);
      },
      testMachine: async (machineId: string) => {
        calls.test.push(machineId);
        return options?.testResult ?? { ok: true as const };
      },
      listDirectories: async (input: { machineId: string; path: string }) => {
        calls.listDirectories.push(input);
        if (input.path === '~') {
          return {
            path: '/home/dev',
            parentPath: '/home',
            directories: [{ name: 'workspace', path: '/home/dev/workspace' }],
          };
        }
        return {
          path: input.path,
          parentPath: '/home/dev',
          directories: [],
        };
      },
      openProject: async (input: { machineId: string; path: string }) => {
        calls.open.push(input);
        return options?.openResult ?? true;
      },
    },
  } as unknown as OkDesktopBridge;

  return { bridge, calls };
}

describe('RemoteProjectDialog', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  test('browses a saved machine, tests the connection, and opens the selected path', async () => {
    const user = userEvent.setup();
    const { bridge, calls } = makeBridge();
    const openChanges: boolean[] = [];
    render(
      <RemoteProjectDialog open onOpenChange={(next) => openChanges.push(next)} bridge={bridge} />,
    );

    expect((await screen.findByRole('combobox', { name: 'SSH machine' })).textContent).toContain(
      'Staging',
    );
    await waitFor(() => {
      expect(calls.listDirectories).toEqual([{ machineId: 'machine-1', path: '~' }]);
    });
    expect(await screen.findByDisplayValue('/home/dev')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connection successful.')).not.toBeNull();
    expect(calls.test).toEqual(['machine-1']);

    await user.click(screen.getByRole('button', { name: 'workspace' }));
    await waitFor(() => {
      expect(calls.listDirectories.at(-1)).toEqual({
        machineId: 'machine-1',
        path: '/home/dev/workspace',
      });
    });
    expect(await screen.findByDisplayValue('/home/dev/workspace')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Up' }));
    await waitFor(() => {
      expect(calls.listDirectories.at(-1)).toEqual({
        machineId: 'machine-1',
        path: '/home/dev',
      });
    });

    const pathInput = await screen.findByLabelText('Remote path');
    await user.clear(pathInput);
    await user.type(pathInput, '/srv/projects/demo ');
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => {
      expect(calls.listDirectories.at(-1)).toEqual({
        machineId: 'machine-1',
        path: '/srv/projects/demo ',
      });
    });

    await user.click(screen.getByRole('button', { name: 'Open project' }));
    await waitFor(() => {
      expect(calls.open).toEqual([{ machineId: 'machine-1', path: '/srv/projects/demo ' }]);
    });
    expect(openChanges).toContain(false);
  });

  test('shows every saved remote when the SSH machine box is clicked', async () => {
    const user = userEvent.setup();
    const production: OkSshMachine = {
      id: 'machine-2',
      name: 'Production',
      host: 'prod.example.com',
    };
    const { bridge } = makeBridge({ machines: [machine, production] });
    render(<RemoteProjectDialog open onOpenChange={() => {}} bridge={bridge} />);

    const machineBox = await screen.findByRole('combobox', { name: 'SSH machine' });
    expect(machineBox.textContent).toContain('staging-box:2222');
    await user.click(machineBox);

    expect(await screen.findByRole('option', { name: /Staging/ })).not.toBeNull();
    const productionOption = await screen.findByRole('option', { name: /Production/ });
    expect(productionOption.textContent).toContain('prod.example.com');
    await user.click(productionOption);
    expect(machineBox.textContent).toContain('Production');
  });

  test('can switch saved machines or close while the initial SSH browse is pending', async () => {
    const user = userEvent.setup();
    const production: OkSshMachine = {
      id: 'machine-2',
      name: 'Production',
      host: 'prod.example.com',
    };
    const { bridge, calls } = makeBridge({ machines: [machine, production] });
    let finishFirstBrowse: (() => void) | undefined;
    const firstBrowse = new Promise<void>((resolve) => {
      finishFirstBrowse = resolve;
    });
    bridge.remote.listDirectories = async (input) => {
      calls.listDirectories.push(input);
      if (input.machineId === machine.id) await firstBrowse;
      return {
        path: input.machineId === production.id ? '/srv/production' : '/home/staging',
        parentPath: '/',
        directories: [],
      };
    };
    const openChanges: boolean[] = [];
    render(
      <RemoteProjectDialog open onOpenChange={(next) => openChanges.push(next)} bridge={bridge} />,
    );

    await waitFor(() =>
      expect(calls.listDirectories).toEqual([{ machineId: machine.id, path: '~' }]),
    );
    const machineBox = await screen.findByRole('combobox', { name: 'SSH machine' });
    expect(machineBox.hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(false);

    await user.click(machineBox);
    await user.click(await screen.findByRole('option', { name: /Production/ }));
    await waitFor(() =>
      expect(calls.listDirectories).toContainEqual({ machineId: production.id, path: '~' }),
    );
    expect(await screen.findByDisplayValue('/srv/production')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(openChanges).toEqual([false]);
    finishFirstBrowse?.();
  });

  test('ignores a dismissed connection test after a new dialog lifecycle starts', async () => {
    const user = userEvent.setup();
    const { bridge, calls } = makeBridge();
    let finishTest: ((result: { ok: true }) => void) | undefined;
    bridge.remote.testMachine = async (machineId) => {
      calls.test.push(machineId);
      return new Promise<{ ok: true }>((resolve) => {
        finishTest = resolve;
      });
    };
    let finishReopenedBrowse: (() => void) | undefined;
    let browseCount = 0;
    bridge.remote.listDirectories = async (input) => {
      calls.listDirectories.push(input);
      browseCount += 1;
      if (browseCount === 2) {
        await new Promise<void>((resolve) => {
          finishReopenedBrowse = resolve;
        });
      }
      return { path: '/home/dev', parentPath: '/home', directories: [] };
    };

    const renderDialog = (open: boolean) => (
      <RemoteProjectDialog open={open} onOpenChange={() => {}} bridge={bridge} />
    );
    const view = render(renderDialog(true));
    await screen.findByDisplayValue('/home/dev');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(calls.test).toEqual([machine.id]));

    view.rerender(renderDialog(false));
    view.rerender(renderDialog(true));
    await waitFor(() => expect(calls.listDirectories).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Open project' }).hasAttribute('disabled')).toBe(
      true,
    );

    finishTest?.({ ok: true });
    await Promise.resolve();
    expect(screen.queryByText('Connection successful.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open project' }).hasAttribute('disabled')).toBe(
      true,
    );

    finishReopenedBrowse?.();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open project' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
  });

  test('keeps keyboard focus on a folder while its navigation request is pending', async () => {
    const user = userEvent.setup();
    const { bridge, calls } = makeBridge();
    let finishFolderBrowse: (() => void) | undefined;
    bridge.remote.listDirectories = async (input) => {
      calls.listDirectories.push(input);
      if (input.path !== '~') {
        await new Promise<void>((resolve) => {
          finishFolderBrowse = resolve;
        });
      }
      return input.path === '~'
        ? {
            path: '/home/dev',
            parentPath: '/home',
            directories: [{ name: 'workspace', path: '/home/dev/workspace' }],
          }
        : { path: input.path, parentPath: '/home/dev', directories: [] };
    };
    render(<RemoteProjectDialog open onOpenChange={() => {}} bridge={bridge} />);

    const folder = await screen.findByRole('button', { name: 'workspace' });
    await user.click(folder);
    await waitFor(() => expect(calls.listDirectories).toHaveLength(2));
    expect(document.activeElement).toBe(folder);
    expect(folder.hasAttribute('disabled')).toBe(false);

    finishFolderBrowse?.();
    await screen.findByText('No folders in this location.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Remote path')));
  });

  test('adds a credential-free machine and validates its optional port', async () => {
    const user = userEvent.setup();
    const { bridge, calls } = makeBridge({ machines: [] });
    render(<RemoteProjectDialog open onOpenChange={() => {}} bridge={bridge} />);

    expect(await screen.findByText(/Passwords and private keys are never stored/)).not.toBeNull();
    expect(screen.queryByLabelText(/Password/i)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Save machine' }));
    const nameError = await screen.findByRole('alert');
    expect(nameError.textContent).toContain('Enter a machine name.');
    expect(screen.getByLabelText('Machine name').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Machine name').getAttribute('aria-describedby')).toBe(
      nameError.id,
    );

    await user.type(screen.getByLabelText('Machine name'), 'Development');
    await user.type(screen.getByLabelText('SSH host or config alias'), 'devbox');
    await user.type(screen.getByLabelText('Port (optional)'), '70000');
    await user.click(screen.getByRole('button', { name: 'Save machine' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Enter a whole-number port from 1 to 65535.',
    );
    expect(screen.getByLabelText('Port (optional)').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Port (optional)').getAttribute('aria-describedby')).toBe(
      screen.getByRole('alert').id,
    );
    expect(calls.save).toEqual([]);

    await user.clear(screen.getByLabelText('Port (optional)'));
    await user.type(screen.getByLabelText('Port (optional)'), '2200');
    await user.click(screen.getByRole('button', { name: 'Save machine' }));

    await waitFor(() => {
      expect(calls.save).toEqual([{ name: 'Development', host: 'devbox', port: 2200 }]);
    });
    expect((await screen.findByRole('combobox', { name: 'SSH machine' })).textContent).toContain(
      'Development',
    );
  });

  test('surfaces connection failures and confirms saved-machine removal without touching remote data', async () => {
    const user = userEvent.setup();
    const { bridge, calls } = makeBridge({
      testResult: { ok: false, error: 'Permission denied (publickey).' },
    });
    render(<RemoteProjectDialog open onOpenChange={() => {}} bridge={bridge} />);

    await screen.findByRole('combobox', { name: 'SSH machine' });
    await waitFor(() => expect(calls.listDirectories).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Permission denied (publickey).',
    );

    await user.click(screen.getByRole('button', { name: 'Remove Staging' }));
    expect(calls.remove).toEqual([]);
    expect(await screen.findByRole('heading', { name: 'Remove SSH machine?' })).not.toBeNull();
    expect(screen.getByText(/saved recent-project and session metadata/)).not.toBeNull();
    expect(
      screen.getByText(/never deletes or changes projects, files, or other data/),
    ).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Remove machine' }));
    await waitFor(() => expect(calls.remove).toEqual(['machine-1']));
    expect(await screen.findByText('Add SSH machine')).not.toBeNull();
  });

  test('keeps an in-flight open non-dismissible and announces its progress', async () => {
    const user = userEvent.setup();
    const { bridge, calls } = makeBridge();
    let finishOpen: (() => void) | null = null;
    const opening = new Promise<boolean>((resolve) => {
      finishOpen = () => resolve(true);
    });
    bridge.remote.openProject = async (input) => {
      calls.open.push(input);
      return opening;
    };
    const openChanges: boolean[] = [];
    render(
      <RemoteProjectDialog open onOpenChange={(next) => openChanges.push(next)} bridge={bridge} />,
    );

    await screen.findByDisplayValue('/home/dev');
    await user.click(screen.getByRole('button', { name: 'Open project' }));

    expect((await screen.findByRole('status')).textContent).toContain('Opening remote project...');
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    await user.keyboard('{Escape}');
    expect(openChanges).toEqual([]);

    finishOpen?.();
    await waitFor(() => expect(openChanges).toEqual([false]));
  });

  test('stays open without an error when native initialization consent is cancelled', async () => {
    const user = userEvent.setup();
    const { bridge, calls } = makeBridge({ openResult: false });
    const openChanges: boolean[] = [];
    render(
      <RemoteProjectDialog open onOpenChange={(next) => openChanges.push(next)} bridge={bridge} />,
    );

    await screen.findByDisplayValue('/home/dev');
    await user.click(screen.getByRole('button', { name: 'Open project' }));

    await waitFor(() =>
      expect(calls.open).toEqual([{ machineId: 'machine-1', path: '/home/dev' }]),
    );
    expect(openChanges).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open project' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  test('associates a directory failure with the path field and names the failed location', async () => {
    const { bridge } = makeBridge();
    bridge.remote.listDirectories = async () => {
      throw new Error(
        "Error invoking remote method 'ok:remote:dispatch': RemoteProjectError: Permission denied.",
      );
    };
    render(<RemoteProjectDialog open onOpenChange={() => {}} bridge={bridge} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not browse the SSH home directory.');
    expect(alert.textContent).toContain('Permission denied.');
    expect(alert.textContent).not.toContain('Error invoking remote method');
    expect(alert.textContent).not.toContain('RemoteProjectError');
    const path = screen.getByLabelText('Remote path');
    expect(path.getAttribute('aria-invalid')).toBe('true');
    expect(path.getAttribute('aria-describedby')).toBe(alert.id);
  });
});

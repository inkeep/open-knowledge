import { describe, expect, mock, test } from 'bun:test';
import type { SshMachine } from '@inkeep/open-knowledge-core';
import { parseRemoteDispatchRequest, resolveRemoteProjectOpen } from './remote-project-open.ts';

const machine: SshMachine = {
  id: 'machine-1',
  name: 'Build box',
  host: 'build-box',
};

describe('resolveRemoteProjectOpen', () => {
  test('opens the inspected project root without prompting when already initialized', async () => {
    const inspection = {
      selectedPath: '/srv/project/docs',
      projectPath: '/srv/project',
      initialized: true,
    };
    const showInitializationDialog = mock(async () => ({ response: 0 }));

    await expect(
      resolveRemoteProjectOpen(machine, inspection, {
        showInitializationDialog,
      }),
    ).resolves.toEqual({ path: '/srv/project', initialize: false });

    expect(showInitializationDialog).not.toHaveBeenCalled();
  });

  test('cancels initialization by default and describes every remote write', async () => {
    const inspection = {
      selectedPath: '/home/dev/wiki',
      projectPath: '/home/dev/wiki',
      initialized: false,
    };
    const showInitializationDialog = mock(async () => ({ response: 0 }));

    await expect(
      resolveRemoteProjectOpen(machine, inspection, { showInitializationDialog }),
    ).resolves.toBeNull();

    const options = showInitializationDialog.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      type: 'warning',
      title: 'Initialize remote project?',
      message: 'Initialize OpenKnowledge on Build box?',
      buttons: ['Cancel', 'Initialize and open'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(options?.detail).toContain('Remote path: /home/dev/wiki');
    expect(options?.detail).toContain('.ok/config.yml');
    expect(options?.detail).toContain('.ok/.gitignore');
    expect(options?.detail).toContain('.okignore');
    expect(options?.detail).toContain('.ok/config.yml and .okignore files are never overwritten');
    expect(options?.detail).toContain(
      'existing .ok/.gitignore may receive missing runtime ignore entries',
    );
  });

  test('initializes only the canonical inspected path after explicit confirmation', async () => {
    const inspection = {
      selectedPath: '/home/dev/wiki',
      projectPath: '/home/dev/wiki',
      initialized: false,
    };

    await expect(
      resolveRemoteProjectOpen(machine, inspection, {
        showInitializationDialog: async () => ({ response: 1 }),
      }),
    ).resolves.toEqual({ path: '/home/dev/wiki', initialize: true });
  });

  test('rejects an unexpected dialog response instead of silently treating it as consent', async () => {
    await expect(
      resolveRemoteProjectOpen(
        machine,
        {
          selectedPath: '/srv/wiki',
          projectPath: '/srv/wiki',
          initialized: false,
        },
        {
          showInitializationDialog: async () => ({ response: 99 }),
        },
      ),
    ).rejects.toThrow('Remote project initialization dialog returned an invalid response.');
  });
});

describe('parseRemoteDispatchRequest', () => {
  test('accepts every exact remote request shape', () => {
    expect(parseRemoteDispatchRequest({ kind: 'list-machines' })).toEqual({
      kind: 'list-machines',
    });
    expect(
      parseRemoteDispatchRequest({
        kind: 'save-machine',
        machine: { id: 'machine-1', name: 'Build box', host: 'build-box', port: 2222 },
      }),
    ).toEqual({
      kind: 'save-machine',
      machine: { id: 'machine-1', name: 'Build box', host: 'build-box', port: 2222 },
    });
    expect(parseRemoteDispatchRequest({ kind: 'remove-machine', machineId: 'machine-1' })).toEqual({
      kind: 'remove-machine',
      machineId: 'machine-1',
    });
    expect(parseRemoteDispatchRequest({ kind: 'test-machine', machineId: 'machine-1' })).toEqual({
      kind: 'test-machine',
      machineId: 'machine-1',
    });
    expect(
      parseRemoteDispatchRequest({
        kind: 'list-directories',
        machineId: 'machine-1',
        path: '/srv',
      }),
    ).toEqual({ kind: 'list-directories', machineId: 'machine-1', path: '/srv' });
    expect(
      parseRemoteDispatchRequest({
        kind: 'open-project',
        machineId: 'machine-1',
        path: '/srv/wiki',
      }),
    ).toEqual({ kind: 'open-project', machineId: 'machine-1', path: '/srv/wiki' });
  });

  test('rejects extra fields and malformed values instead of silently dropping them', () => {
    expect(
      parseRemoteDispatchRequest({
        kind: 'open-project',
        machineId: 'machine-1',
        path: '/srv/wiki',
        initialize: true,
      }),
    ).toBeNull();
    expect(
      parseRemoteDispatchRequest({ kind: 'open-project', machineId: '', path: '/srv/wiki' }),
    ).toBeNull();
    expect(
      parseRemoteDispatchRequest({ kind: 'open-project', machineId: 'machine-1', path: '' }),
    ).toBeNull();
    expect(parseRemoteDispatchRequest({ kind: 'list-machines', legacy: true })).toBeNull();
    expect(
      parseRemoteDispatchRequest({
        kind: 'save-machine',
        machine: { name: 'Build box', host: 'build-box', password: 'secret' },
      }),
    ).toBeNull();
  });
});

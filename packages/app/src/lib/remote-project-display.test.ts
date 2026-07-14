import { describe, expect, test } from 'bun:test';
import { desktopProjectLocation } from './remote-project-display';

describe('desktopProjectLocation', () => {
  test('keeps a local project filesystem path', () => {
    expect(desktopProjectLocation({ projectPath: '/Users/me/project' })).toBe('/Users/me/project');
  });

  test('shows the SSH machine and canonical remote path instead of the opaque project key', () => {
    const opaqueKey = 'ssh:machine-1:%2Fsrv%2Fknowledge';
    const location = desktopProjectLocation({
      projectPath: opaqueKey,
      remote: {
        kind: 'ssh',
        machineId: 'machine-1',
        machineName: 'Build box',
        path: '/srv/knowledge',
        platform: 'linux',
        pathSeparator: '/',
      },
    });

    expect(location).toBe('Build box • /srv/knowledge');
    expect(location).not.toContain(opaqueKey);
  });
});

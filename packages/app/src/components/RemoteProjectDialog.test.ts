import { describe, expect, test } from 'bun:test';
import {
  formatRemoteProjectError,
  formatSshMachineTarget,
  validateRemoteMachineDraft,
} from './RemoteProjectDialog';

describe('validateRemoteMachineDraft', () => {
  test('trims a machine name and SSH target and omits an empty port', () => {
    expect(
      validateRemoteMachineDraft({
        name: '  Development  ',
        host: '  devbox  ',
        port: '   ',
      }),
    ).toEqual({
      ok: true,
      value: { name: 'Development', host: 'devbox' },
    });
  });

  test('accepts an explicit port at the inclusive SSH port boundaries', () => {
    expect(validateRemoteMachineDraft({ name: 'Low', host: 'low', port: '1' })).toEqual({
      ok: true,
      value: { name: 'Low', host: 'low', port: 1 },
    });
    expect(validateRemoteMachineDraft({ name: 'High', host: 'high', port: '65535' })).toEqual({
      ok: true,
      value: { name: 'High', host: 'high', port: 65_535 },
    });
  });

  test('rejects missing fields and invalid ports', () => {
    expect(validateRemoteMachineDraft({ name: ' ', host: 'devbox', port: '' })).toEqual({
      ok: false,
      error: 'name-required',
    });
    expect(validateRemoteMachineDraft({ name: 'Dev', host: ' ', port: '' })).toEqual({
      ok: false,
      error: 'host-required',
    });

    for (const port of ['0', '65536', '22.5', '2e1', '0x16', '+22', 'not-a-port']) {
      expect(validateRemoteMachineDraft({ name: 'Dev', host: 'devbox', port })).toEqual({
        ok: false,
        error: 'port-invalid',
      });
    }
  });
});

describe('formatSshMachineTarget', () => {
  test('only appends a port when one is explicitly configured', () => {
    expect(formatSshMachineTarget({ host: 'devbox' })).toBe('devbox');
    expect(formatSshMachineTarget({ host: 'user@example.com', port: 2222 })).toBe(
      'user@example.com:2222',
    );
  });
});

describe('formatRemoteProjectError', () => {
  test('removes Electron and remote-project implementation wrappers', () => {
    expect(
      formatRemoteProjectError(
        new Error(
          "Error invoking remote method 'ok:remote:dispatch': RemoteProjectError: Install failed.",
        ),
        'Fallback',
      ),
    ).toBe('Install failed.');
  });

  test('keeps actionable errors and uses the fallback for an empty or non-error value', () => {
    expect(formatRemoteProjectError(new Error('Permission denied.'), 'Fallback')).toBe(
      'Permission denied.',
    );
    expect(formatRemoteProjectError(new Error(''), 'Fallback')).toBe('Fallback');
    expect(formatRemoteProjectError('failed', 'Fallback')).toBe('Fallback');
  });
});

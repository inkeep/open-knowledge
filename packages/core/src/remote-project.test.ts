import { describe, expect, test } from 'bun:test';
import { isRemoteProjectKey, isSafeSshDestination, remoteProjectKey } from './remote-project';

describe('remoteProjectKey', () => {
  test('scopes a path to its machine and escapes delimiter characters', () => {
    expect(remoteProjectKey('machine:one', '/srv/a project')).toBe(
      'ssh:machine%3Aone:%2Fsrv%2Fa%20project',
    );
    expect(remoteProjectKey('machine-two', '/srv/a project')).not.toBe(
      remoteProjectKey('machine:one', '/srv/a project'),
    );
  });

  test('recognizes only opaque SSH project keys', () => {
    expect(isRemoteProjectKey(remoteProjectKey('machine', '/srv/project'))).toBe(true);
    expect(isRemoteProjectKey('ssh:')).toBe(false);
    expect(isRemoteProjectKey('ssh:machine')).toBe(false);
    expect(isRemoteProjectKey('ssh:machine:%broken')).toBe(false);
    expect(isRemoteProjectKey('/Users/me/ssh:project')).toBe(false);
    expect(isRemoteProjectKey('https://example.com/project')).toBe(false);
  });
});

describe('isSafeSshDestination', () => {
  test('accepts ordinary aliases, hostnames, and user-qualified hosts', () => {
    expect(isSafeSshDestination('build-box')).toBe(true);
    expect(isSafeSshDestination('dev.example.com')).toBe(true);
    expect(isSafeSshDestination('developer@build_box')).toBe(true);
  });

  test('rejects shell expansion, globs, IPv6 literals, and option-like hosts', () => {
    for (const value of [
      '-proxy',
      'host name',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell-injection payload.
      'x;touch${IFS}/tmp/pwn',
      '$(touch-pwn)',
      'host|command',
      'wild*card',
      '[::1]',
    ]) {
      expect(isSafeSshDestination(value)).toBe(false);
    }
  });
});

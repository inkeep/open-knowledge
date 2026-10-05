import { describe, expect, test } from 'vitest';
import {
  classifyGitHubShareHost,
  credentialHostFromRemoteUrl,
  declaredGitHubHostsFrom,
  gitCredentialHostKey,
  isGitHubHost,
  normalizeGitHostname,
} from './github.ts';

describe('normalizeGitHostname', () => {
  test('lowercases the hostname', () => {
    expect(normalizeGitHostname('GitHub.COM')).toBe('github.com');
  });

  test('strips a trailing port', () => {
    expect(normalizeGitHostname('git.example.internal:8443')).toBe('git.example.internal');
  });

  test('folds www.github.com to github.com', () => {
    expect(normalizeGitHostname('www.github.com')).toBe('github.com');
  });

  test('folds a cased, ported www.github.com', () => {
    expect(normalizeGitHostname('WWW.GitHub.com:443')).toBe('github.com');
  });

  test('leaves an unrelated host alone', () => {
    expect(normalizeGitHostname('gitlab.com')).toBe('gitlab.com');
  });
});

describe('isGitHubHost', () => {
  test('github.com is GitHub with no declared set', () => {
    expect(isGitHubHost('github.com')).toBe(true);
  });

  test('github.com is GitHub alongside a declared set', () => {
    expect(isGitHubHost('github.com', new Set(['ghes.example.com']))).toBe(true);
  });

  test('www.github.com folds to github.com', () => {
    expect(isGitHubHost('www.github.com')).toBe(true);
  });

  test('an undeclared self-hosted host is not GitHub', () => {
    expect(isGitHubHost('git.example.internal')).toBe(false);
  });

  test('an undeclared self-hosted host is not GitHub against a non-matching declared set', () => {
    expect(isGitHubHost('git.example.internal', new Set(['ghes.example.com']))).toBe(false);
  });

  test('a declared host is GitHub', () => {
    expect(isGitHubHost('git.example.internal', new Set(['git.example.internal']))).toBe(true);
  });

  test('a declared match is case-insensitive', () => {
    expect(isGitHubHost('GIT.Example.Internal', new Set(['git.example.internal']))).toBe(true);
  });

  test('a declared match ignores a port on the queried host', () => {
    expect(isGitHubHost('git.example.internal:8443', new Set(['git.example.internal']))).toBe(true);
  });

  test('a formerly denylisted forge is not GitHub', () => {
    expect(isGitHubHost('gitlab.com')).toBe(false);
  });

  test.each(['github.example.com', 'notgithub.example.com', 'ssh.github.com'])(
    'a host whose name merely contains github is not GitHub until declared: %s',
    (host) => {
      expect(isGitHubHost(host)).toBe(false);
      expect(isGitHubHost(host, new Set([host]))).toBe(true);
    },
  );
});

describe('declaredGitHubHostsFrom', () => {
  test('returns an empty set for undefined', () => {
    expect([...declaredGitHubHostsFrom(undefined)]).toEqual([]);
  });

  test('returns an empty set for an empty record', () => {
    expect([...declaredGitHubHostsFrom({})]).toEqual([]);
  });

  test('picks only entries whose provider is github', () => {
    const declared = declaredGitHubHostsFrom({
      'ghes.example.com': { provider: 'github' },
      'git.example.internal': {},
      'other.example.com': undefined,
    });
    expect([...declared]).toEqual(['ghes.example.com']);
  });

  test('normalizes declared hostnames', () => {
    const declared = declaredGitHubHostsFrom({
      'GHES.Example.COM:8443': { provider: 'github' },
      'www.github.com': { provider: 'github' },
    });
    expect([...declared].sort()).toEqual(['ghes.example.com', 'github.com']);
  });

  test('skips a hostname that normalizes to empty', () => {
    expect([...declaredGitHubHostsFrom({ '': { provider: 'github' } })]).toEqual([]);
  });
});

describe('classifyGitHubShareHost', () => {
  test('still rejects gitlab.com', () => {
    expect(classifyGitHubShareHost('gitlab.com')).toBeNull();
  });

  test('still admits an unknown enterprise host', () => {
    expect(classifyGitHubShareHost('ghes.example.com')).toBe('ghes.example.com');
  });

  test('still folds www.github.com', () => {
    expect(classifyGitHubShareHost('www.github.com')).toBe('github.com');
  });
});

describe('gitCredentialHostKey', () => {
  test('lowercases the host', () => {
    expect(gitCredentialHostKey('Git.Example.COM')).toBe('git.example.com');
  });

  test('keeps a non-default port', () => {
    expect(gitCredentialHostKey('Git.Example.com:8443')).toBe('git.example.com:8443');
  });

  test('drops the default HTTPS port', () => {
    expect(gitCredentialHostKey('git.example.com:443')).toBe('git.example.com');
    expect(gitCredentialHostKey('git.example.com:443', 'https')).toBe('git.example.com');
  });

  test('drops the default HTTP port only for http', () => {
    expect(gitCredentialHostKey('git.example.com:80', 'http')).toBe('git.example.com');
    expect(gitCredentialHostKey('git.example.com:80', 'https')).toBe('git.example.com:80');
    expect(gitCredentialHostKey('git.example.com:443', 'http')).toBe('git.example.com:443');
  });

  test('keeps the port for a protocol with no known default', () => {
    expect(gitCredentialHostKey('git.example.com:443', 'ssh')).toBe('git.example.com:443');
  });

  test('does not fold www.github.com', () => {
    expect(gitCredentialHostKey('www.github.com')).toBe('www.github.com');
  });
});

describe('credentialHostFromRemoteUrl', () => {
  test.each([
    ['https://git.example.com/team/kb.git', 'git.example.com'],
    ['https://alice@Git.Example.com:8443/team/kb.git', 'git.example.com:8443'],
    ['https://git.example.com:443/team/kb.git', 'git.example.com'],
    ['http://git.example.com:80/team/kb.git', 'git.example.com'],
    ['http://git.example.com:8080/team/kb.git', 'git.example.com:8080'],
    ['https://gitlab.example.com/group/sub/kb.git', 'gitlab.example.com'],
    ['https://dev.azure.com/org/proj/_git/kb', 'dev.azure.com'],
    ['https://git.example.com', 'git.example.com'],
    ['ssh://git@Git.Example.com:2222/team/kb.git', 'git.example.com'],
    ['git@Git.Example.com:team/kb.git', 'git.example.com'],
    ['git://git.example.com:9418/team/kb.git', 'git.example.com'],
  ])('%s -> %s', (url, expected) => {
    expect(credentialHostFromRemoteUrl(url)).toBe(expected);
  });

  test.each(['', '/srv/git/kb.git', '../kb', 'C:\\repos\\kb'])('%j has no host', (url) => {
    expect(credentialHostFromRemoteUrl(url)).toBeNull();
  });
});

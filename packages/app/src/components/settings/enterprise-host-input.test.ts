import type { Config } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { declaredEnterpriseHosts, parseEnterpriseHostInput } from './enterprise-host-input';

describe('parseEnterpriseHostInput', () => {
  const none = new Set<string>();

  test.each([
    ['ghes.example.com', 'ghes.example.com'],
    ['  GHES.Example.COM  ', 'ghes.example.com'],
    ['ghes.example.com:8443', 'ghes.example.com'],
    ['https://ghes.example.com/team/kb.git', 'ghes.example.com'],
    ['https://user@ghes.example.com:8443/team/kb', 'ghes.example.com'],
    ['ssh://git@ghes.example.com/team/kb.git', 'ghes.example.com'],
    ['git@ghes.example.com:team/kb.git', 'ghes.example.com'],
    ['ghes.example.com/team/kb', 'ghes.example.com'],
    ['127.0.0.1', '127.0.0.1'],
    ['git-internal', 'git-internal'],
  ])('accepts %j as %j', (raw, host) => {
    expect(parseEnterpriseHostInput(raw, none)).toEqual({ ok: true, host });
  });

  test.each(['github.example.com', 'https://github.acme.test/team/kb.git'])(
    'accepts %j, because only github.com itself is recognized without a declaration',
    (raw) => {
      expect(parseEnterpriseHostInput(raw, none)).toMatchObject({ ok: true });
    },
  );

  test('rejects empty input', () => {
    expect(parseEnterpriseHostInput('   ', none)).toEqual({ ok: false, reason: 'empty' });
  });

  test.each(['not a host', 'bad_host.example', '-leading.example', 'https://', '...'])(
    'rejects malformed input %j',
    (raw) => {
      expect(parseEnterpriseHostInput(raw, none)).toEqual({ ok: false, reason: 'invalid' });
    },
  );

  test.each(['github.com', 'www.github.com', 'https://github.com/o/r'])(
    'rejects %j because github.com is always recognized',
    (raw) => {
      expect(parseEnterpriseHostInput(raw, none)).toEqual({ ok: false, reason: 'github-com' });
    },
  );

  test('rejects a host already declared, comparing normalized names', () => {
    expect(parseEnterpriseHostInput('GHES.example.com', new Set(['ghes.example.com']))).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });
});

describe('declaredEnterpriseHosts', () => {
  function config(hosts: Config['git']['hosts']): Config {
    return { git: { hosts } } as Config;
  }

  test('lists only github-provider entries, sorted, keeping the stored key', () => {
    expect(
      declaredEnterpriseHosts(
        config({
          'zeta.example.com': { provider: 'github' },
          'Alpha.Example.com': { provider: 'github' },
          'no-provider.example.com': {},
        }),
      ),
    ).toEqual(['Alpha.Example.com', 'zeta.example.com']);
  });

  test('tolerates a config with no git section', () => {
    expect(declaredEnterpriseHosts({} as Config)).toEqual([]);
  });
});

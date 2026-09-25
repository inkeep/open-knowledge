import { describe, expect, test, vi } from 'vitest';
import { getLogger } from '../logger.ts';
import { createGitHubTokenResolver, mayUseGitHubToken } from './token-resolver.ts';

describe('mayUseGitHubToken', () => {
  test('only a direct loopback caller may spend the GitHub sign-in', () => {
    expect(mayUseGitHubToken({ socket: { remoteAddress: '127.0.0.1' }, headers: {} })).toBe(true);
    expect(mayUseGitHubToken({ socket: { remoteAddress: '::1' }, headers: {} })).toBe(true);
    expect(
      mayUseGitHubToken({
        socket: { remoteAddress: '203.0.113.9' },
        headers: { origin: 'http://localhost:5173', host: 'localhost' },
      }),
    ).toBe(false);
    expect(
      mayUseGitHubToken({
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-forwarded-for': '203.0.113.9' },
      }),
    ).toBe(false);
    expect(mayUseGitHubToken({ socket: undefined, headers: {} })).toBe(false);
  });
});

describe('createGitHubTokenResolver', () => {
  test('prefers the gh CLI token, then the stored sign-in, else reads anonymously', async () => {
    const withGh = createGitHubTokenResolver(() => ({ available: true, token: 'gh-token' }), {
      get: async () => ({ token: 'stored' }),
    });
    expect(await withGh('github.com')).toBe('gh-token');

    const hosts: string[] = [];
    const stored = createGitHubTokenResolver(() => ({ available: false }), {
      get: async (host) => {
        hosts.push(host);
        return { token: 'stored' };
      },
    });
    expect(await stored('git.example.com')).toBe('stored');
    expect(hosts).toEqual(['git.example.com']);

    expect(await createGitHubTokenResolver(undefined, null)('github.com')).toBeNull();
  });

  test('a token store that fails reads anonymously and logs which host it was asked for', async () => {
    const warn = vi.spyOn(getLogger('github-reference'), 'warn').mockImplementation(() => {});
    try {
      const broken = createGitHubTokenResolver(undefined, {
        get: async () => {
          throw new Error('keychain locked');
        },
      });
      expect(await broken('git.example.com')).toBeNull();
      expect(warn.mock.calls[0]?.[0]).toEqual({ err: expect.any(Error), host: 'git.example.com' });
    } finally {
      warn.mockRestore();
    }
  });
});

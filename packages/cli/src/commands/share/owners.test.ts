/**
 * Unit tests for `listShareOwners` — covers the per-owner filter, pagination,
 * and the auth-required / network error mapping. The Octokit instance is
 * stubbed; no network or token-store work happens in this file.
 */

import { describe, expect, test } from 'bun:test';
import type { Octokit } from '@octokit/rest';
import { listShareOwners } from './owners.ts';

interface OrgMembershipFixture {
  organization: { login: string; avatar_url?: string | null };
  permissions?: { can_create_repository: boolean };
  role?: 'admin' | 'member';
}

interface FakeOctokitOptions {
  user?:
    | { login: string; avatar_url?: string }
    | { __throw: { status?: number; message?: string } };
  memberships?: OrgMembershipFixture[] | { __throw: { status?: number; message?: string } };
}

/**
 * Build an Octokit-shaped fake with just the methods `listShareOwners`
 * touches. The `paginate.iterator` returns one page per call to mirror the
 * iterator-protocol the real Octokit exposes.
 */
function makeFakeOctokit(opts: FakeOctokitOptions): Octokit {
  const memberships = opts.memberships;
  const user = opts.user ?? { login: 'octocat', avatar_url: 'https://avatar/octocat' };

  return {
    users: {
      getAuthenticated: async () => {
        if (user && '__throw' in user) {
          throw Object.assign(new Error(user.__throw.message ?? 'fake'), {
            status: user.__throw.status,
          });
        }
        return { data: user };
      },
    },
    orgs: {
      listMembershipsForAuthenticatedUser: () => ({}),
    },
    paginate: {
      iterator() {
        return {
          async *[Symbol.asyncIterator]() {
            if (memberships && '__throw' in memberships) {
              throw Object.assign(new Error(memberships.__throw.message ?? 'fake'), {
                status: memberships.__throw.status,
              });
            }
            yield { data: memberships ?? [] };
          },
        };
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only fake; only the touched surface matters.
  } as any;
}

describe('listShareOwners', () => {
  test('returns the authenticated user as the first owner', async () => {
    const result = await listShareOwners(
      makeFakeOctokit({ user: { login: 'alice', avatar_url: 'https://avatar/alice' } }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.owners[0]).toEqual({
      login: 'alice',
      kind: 'user',
      avatarUrl: 'https://avatar/alice',
    });
  });

  test('includes orgs where can_create_repository is true', async () => {
    const result = await listShareOwners(
      makeFakeOctokit({
        memberships: [
          {
            organization: { login: 'good-org', avatar_url: 'https://avatar/good' },
            permissions: { can_create_repository: true },
          },
        ],
      }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.owners.map((o) => o.login)).toContain('good-org');
    const good = result.owners.find((o) => o.login === 'good-org');
    expect(good).toEqual({ login: 'good-org', kind: 'org', avatarUrl: 'https://avatar/good' });
  });

  test('drops orgs where can_create_repository is false', async () => {
    const result = await listShareOwners(
      makeFakeOctokit({
        memberships: [
          {
            organization: { login: 'good-org' },
            permissions: { can_create_repository: true },
          },
          {
            organization: { login: 'restricted-org' },
            permissions: { can_create_repository: false },
          },
        ],
      }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.owners.map((o) => o.login)).toEqual(['octocat', 'good-org']);
  });

  test('drops orgs missing the permissions block AND member-only role (fail-closed)', async () => {
    const result = await listShareOwners(
      makeFakeOctokit({
        memberships: [{ organization: { login: 'mystery-org' }, role: 'member' }],
      }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.owners.map((o) => o.login)).toEqual(['octocat']);
  });

  test('includes admin-role orgs even when permissions block is absent', async () => {
    // Realistic scenario: OAuth token with default `repo` scope does not get
    // the `permissions.can_create_repository` field populated by GitHub.
    // For admin-role memberships, the role itself is a sufficient signal
    // that the user can create repos — drop fail-closed in this case.
    const result = await listShareOwners(
      makeFakeOctokit({
        memberships: [{ organization: { login: 'my-admin-org' }, role: 'admin' }],
      }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.owners.map((o) => o.login)).toEqual(['octocat', 'my-admin-org']);
  });

  test('includes admin-role orgs even when permissions explicitly says false', async () => {
    // Defense-in-depth: if GitHub's permissions block disagrees with role,
    // role wins for admins (org admins can always create repos in their
    // own org by policy regardless of repository creation restrictions).
    const result = await listShareOwners(
      makeFakeOctokit({
        memberships: [
          {
            organization: { login: 'admin-but-restricted' },
            role: 'admin',
            permissions: { can_create_repository: false },
          },
        ],
      }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.owners.map((o) => o.login)).toEqual(['octocat', 'admin-but-restricted']);
  });

  test('null org avatar_url drops to undefined', async () => {
    const result = await listShareOwners(
      makeFakeOctokit({
        memberships: [
          {
            organization: { login: 'org-no-avatar', avatar_url: null },
            permissions: { can_create_repository: true },
          },
        ],
      }),
    );
    if (result.kind !== 'ok') throw new Error('expected ok');
    const org = result.owners.find((o) => o.login === 'org-no-avatar');
    expect(org).toEqual({ login: 'org-no-avatar', kind: 'org', avatarUrl: undefined });
  });

  test('401 from getAuthenticated → auth-required', async () => {
    const result = await listShareOwners(
      makeFakeOctokit({ user: { __throw: { status: 401, message: 'Bad credentials' } } }),
    );
    expect(result).toEqual({ kind: 'auth-required' });
  });

  test('500 from getAuthenticated → network', async () => {
    const result = await listShareOwners(
      makeFakeOctokit({ user: { __throw: { status: 500, message: 'oops' } } }),
    );
    expect(result).toEqual({ kind: 'network' });
  });

  test('401 from org pagination → auth-required', async () => {
    const result = await listShareOwners(
      makeFakeOctokit({ memberships: { __throw: { status: 401, message: 'Bad credentials' } } }),
    );
    expect(result).toEqual({ kind: 'auth-required' });
  });
});

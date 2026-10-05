import { describe, expect, test } from 'vitest';
import {
  LocalOpAuthEmptySuccessSchema,
  LocalOpAuthHostRequestSchema,
  LocalOpAuthSetIdentityRequestSchema,
  LocalOpAuthStatusSuccessSchema,
  LocalOpAuthTokenRequestSchema,
  ProblemTypeSchema,
} from './index.ts';

describe('Cluster G URN tokens (US-012)', () => {
  test('auth-failed is a member of ProblemTypeSchema', () => {
    expect(ProblemTypeSchema.safeParse('urn:ok:error:auth-failed').success).toBe(true);
  });
  test('no-project-dir is a member of ProblemTypeSchema', () => {
    expect(ProblemTypeSchema.safeParse('urn:ok:error:no-project-dir').success).toBe(true);
  });
  test('server-open-failed is a member of ProblemTypeSchema', () => {
    expect(ProblemTypeSchema.safeParse('urn:ok:error:server-open-failed').success).toBe(true);
  });
});

describe('LocalOpAuthHostRequestSchema', () => {
  test('parses with host', () => {
    expect(LocalOpAuthHostRequestSchema.safeParse({ host: 'github.com' }).success).toBe(true);
  });
  test('parses without host (optional)', () => {
    expect(LocalOpAuthHostRequestSchema.safeParse({}).success).toBe(true);
  });
  test('rejects empty host', () => {
    expect(LocalOpAuthHostRequestSchema.safeParse({ host: '' }).success).toBe(false);
  });
});

describe('LocalOpAuthSetIdentityRequestSchema', () => {
  test('parses valid name + email', () => {
    expect(
      LocalOpAuthSetIdentityRequestSchema.safeParse({
        name: 'Alice Tester',
        email: 'alice@example.com',
      }).success,
    ).toBe(true);
  });
  test('rejects whitespace-only name', () => {
    expect(
      LocalOpAuthSetIdentityRequestSchema.safeParse({
        name: '   ',
        email: 'alice@example.com',
      }).success,
    ).toBe(false);
  });
  test('rejects whitespace-only email', () => {
    expect(
      LocalOpAuthSetIdentityRequestSchema.safeParse({
        name: 'Alice',
        email: '   ',
      }).success,
    ).toBe(false);
  });
  test('rejects missing fields', () => {
    expect(LocalOpAuthSetIdentityRequestSchema.safeParse({ name: 'Alice' }).success).toBe(false);
  });
});

describe('LocalOpAuthStatusSuccessSchema', () => {
  test('parses authenticated:true', () => {
    expect(LocalOpAuthStatusSuccessSchema.safeParse({ authenticated: true }).success).toBe(true);
  });
  test('parses authenticated:false', () => {
    expect(LocalOpAuthStatusSuccessSchema.safeParse({ authenticated: false }).success).toBe(true);
  });
  test('preserves CLI-emitted extras via .loose()', () => {
    expect(
      LocalOpAuthStatusSuccessSchema.safeParse({
        authenticated: true,
        login: 'alice',
        host: 'github.com',
      }).success,
    ).toBe(true);
  });
  test('rejects missing authenticated field', () => {
    expect(LocalOpAuthStatusSuccessSchema.safeParse({ login: 'alice' }).success).toBe(false);
  });
});

describe('LocalOpAuthTokenRequestSchema', () => {
  const valid = { host: 'ghes.test', username: 'alice', token: 'tkn-1' };

  test('parses a full host + username + token body', () => {
    expect(LocalOpAuthTokenRequestSchema.safeParse(valid).success).toBe(true);
  });
  test('rejects a missing host', () => {
    expect(
      LocalOpAuthTokenRequestSchema.safeParse({ username: 'alice', token: 'tkn-1' }).success,
    ).toBe(false);
  });
  test('rejects an empty host', () => {
    expect(LocalOpAuthTokenRequestSchema.safeParse({ ...valid, host: '' }).success).toBe(false);
  });
  test.each(['https://ghes.test', 'ghes.test/team', 'ghes.test/', 'alice@ghes.test'])(
    'rejects %s, a host git never sends to a credential helper',
    (host) => {
      expect(LocalOpAuthTokenRequestSchema.safeParse({ ...valid, host }).success).toBe(false);
    },
  );
  test('accepts a host with a port', () => {
    expect(
      LocalOpAuthTokenRequestSchema.safeParse({ ...valid, host: 'ghes.test:8443' }).success,
    ).toBe(true);
  });
  test('rejects a missing username', () => {
    expect(
      LocalOpAuthTokenRequestSchema.safeParse({ host: 'ghes.test', token: 'tkn-1' }).success,
    ).toBe(false);
  });
  test('rejects an empty username', () => {
    expect(LocalOpAuthTokenRequestSchema.safeParse({ ...valid, username: '' }).success).toBe(false);
  });
  test('rejects a missing token', () => {
    expect(
      LocalOpAuthTokenRequestSchema.safeParse({ host: 'ghes.test', username: 'alice' }).success,
    ).toBe(false);
  });
  test('rejects an empty token', () => {
    expect(LocalOpAuthTokenRequestSchema.safeParse({ ...valid, token: '' }).success).toBe(false);
  });
});

describe('LocalOpAuthEmptySuccessSchema', () => {
  test('parses empty body', () => {
    expect(LocalOpAuthEmptySuccessSchema.safeParse({}).success).toBe(true);
  });
  test('preserves forward-compat fields via .loose()', () => {
    expect(
      LocalOpAuthEmptySuccessSchema.safeParse({ signedOutAt: '2026-04-30T10:00:00.000Z' }).success,
    ).toBe(true);
  });
});

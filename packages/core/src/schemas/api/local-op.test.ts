import { describe, expect, test } from 'bun:test';
import {
  LocalOpAuthEmptySuccessSchema,
  LocalOpAuthHostRequestSchema,
  LocalOpAuthSetIdentityRequestSchema,
  LocalOpAuthStatusSuccessSchema,
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

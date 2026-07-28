import { describe, expect, test } from 'vitest';
import {
  buildPendingShareCookie,
  decideContinue,
  PENDING_SHARE_COOKIE,
  PENDING_SHARE_MAX_AGE_SECONDS,
} from './deferred-share.ts';

const VALID_TOKEN = 'AWh0dHBzOi8vZ2l0aHViLmNvbS9pbmtlZXAvdGVjaC1pcG9z';
const VALID_NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('buildPendingShareCookie', () => {
  test('sets HttpOnly/Secure/Lax first-party cookie with the 7-day max-age', () => {
    const cookie = buildPendingShareCookie(VALID_TOKEN);
    expect(cookie.name).toBe(PENDING_SHARE_COOKIE);
    expect(cookie.value).toBe(VALID_TOKEN);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe('lax');
    expect(cookie.path).toBe('/');
    expect(cookie.maxAge).toBe(PENDING_SHARE_MAX_AGE_SECONDS);
    expect(PENDING_SHARE_MAX_AGE_SECONDS).toBe(604800);
  });
});

describe('decideContinue — redeem branch', () => {
  test('redirects the pending token to the loopback listener when all inputs are valid', () => {
    const decision = decideContinue({
      cookieToken: VALID_TOKEN,
      port: '52431',
      nonce: VALID_NONCE,
    });
    expect(decision.kind).toBe('redeem');
    if (decision.kind !== 'redeem') throw new Error('unreachable');
    expect(decision.location).toBe(
      `http://127.0.0.1:52431/redeem?token=${VALID_TOKEN}&nonce=${VALID_NONCE}`,
    );
  });

  test('host is hardcoded loopback — only the numeric port is taken from input', () => {
    const decision = decideContinue({ cookieToken: VALID_TOKEN, port: '1', nonce: VALID_NONCE });
    if (decision.kind !== 'redeem') throw new Error('expected redeem');
    expect(decision.location.startsWith('http://127.0.0.1:1/redeem?')).toBe(true);
  });
});

describe('decideContinue — welcome branch', () => {
  test('no handshake params → welcome, cookie retained (direct visit must not burn the pairing)', () => {
    const decision = decideContinue({ cookieToken: VALID_TOKEN, port: null, nonce: null });
    expect(decision).toEqual({ kind: 'welcome', clearCookie: false });
  });

  test('valid params but no cookie → welcome, nothing to clear', () => {
    const decision = decideContinue({ cookieToken: null, port: '52431', nonce: VALID_NONCE });
    expect(decision).toEqual({ kind: 'welcome', clearCookie: false });
  });

  test('valid params but malformed cookie → welcome + clear the bad cookie', () => {
    const decision = decideContinue({
      cookieToken: 'not valid base64url!!',
      port: '52431',
      nonce: VALID_NONCE,
    });
    expect(decision).toEqual({ kind: 'welcome', clearCookie: true });
  });

  test.each([
    ['port out of range (0)', '0', VALID_NONCE],
    ['port out of range (70000)', '70000', VALID_NONCE],
    ['non-numeric port', '52431a', VALID_NONCE],
    ['non-hex nonce', '52431', 'ZZZZ'],
    ['nonce too short', '52431', 'a1b2'],
  ])('rejects %s → welcome (no redeem)', (_label, port, nonce) => {
    const decision = decideContinue({ cookieToken: VALID_TOKEN, port, nonce });
    expect(decision.kind).toBe('welcome');
  });

  test('over-length token is rejected even with valid params', () => {
    const decision = decideContinue({
      cookieToken: 'A'.repeat(5000),
      port: '52431',
      nonce: VALID_NONCE,
    });
    expect(decision.kind).toBe('welcome');
    if (decision.kind !== 'welcome') throw new Error('unreachable');
    expect(decision.clearCookie).toBe(true);
  });
});

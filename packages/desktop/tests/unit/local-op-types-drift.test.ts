import type {
  AuthEvent,
  AuthReposResponse,
  AuthStatusResponse,
  RawCloneEvent,
} from '@inkeep/open-knowledge-server';
import { describe, expect, test } from 'vitest';
import type {
  OkLocalOpAuthEvent,
  OkLocalOpAuthReposResponse,
  OkLocalOpAuthStatusResponse,
  OkLocalOpCloneEvent,
} from '../../src/shared/bridge-contract.ts';

type Eq<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

describe('local-op type drift (server runner ↔ desktop bridge contract)', () => {
  test('AuthEvent ≡ OkLocalOpAuthEvent (device-flow streaming events)', () => {
    const _eq: Eq<AuthEvent, OkLocalOpAuthEvent> = true;
    expect(_eq).toBe(true);
  });

  test('RawCloneEvent ≡ OkLocalOpCloneEvent (clone streaming events)', () => {
    const _eq: Eq<RawCloneEvent, OkLocalOpCloneEvent> = true;
    expect(_eq).toBe(true);
  });

  test('AuthStatusResponse ≡ OkLocalOpAuthStatusResponse (one-shot auth status)', () => {
    const _eq: Eq<AuthStatusResponse, OkLocalOpAuthStatusResponse> = true;
    expect(_eq).toBe(true);
  });

  test('AuthReposResponse ≡ OkLocalOpAuthReposResponse (one-shot repos list)', () => {
    const _eq: Eq<AuthReposResponse, OkLocalOpAuthReposResponse> = true;
    expect(_eq).toBe(true);
  });
});

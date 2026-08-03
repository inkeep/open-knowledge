/**
 * Local-op type-drift catcher across the server ↔ desktop bridge boundary.
 *
 * Server-side runner output types and the desktop host contract types
 * are duplicated by design:
 *   - Server is published as a standalone library and can't depend on
 *     desktop.
 *   - The desktop host contract avoids importing server to keep server's
 *     compilation tree (markdown / CRDT) out of the renderer build.
 *
 * Without this test, a field added on one side (e.g. `scopes: string[]`
 * on `AuthStatusResponse`) silently propagates to the IPC handler return
 * but is invisible to the renderer's bridge type — typecheck stays green
 * while the renderer can't read the new field. The two-edge TS check
 * (`handle()` registration + preload `invoke()` assignment) only catches
 * removals + breaking changes, not additive drift.
 *
 * Pattern: `Eq<X, Y>` mutual-assignability invariant, complementing the
 * source-only core bridge contract guard.
 */

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

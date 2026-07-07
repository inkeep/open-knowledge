/**
 * Local-op type-drift catcher across the server ↔ desktop bridge boundary.
 *
 * Server-side runner output types and desktop-side bridge-contract types
 * are duplicated by design:
 *   - Server is published as a standalone library and can't depend on
 *     desktop.
 *   - Desktop's bridge contracts avoid importing server to keep server's
 *     compilation tree (markdown / CRDT) out of the renderer build —
 *     rationale lives in `bridge-contract.ts`'s top JSDoc.
 *
 * Without this test, a field added on one side (e.g. `scopes: string[]`
 * on `AuthStatusResponse`) silently propagates to the IPC handler return
 * but is invisible to the renderer's bridge type — typecheck stays green
 * while the renderer can't read the new field. The two-edge TS check
 * (`handle()` registration + preload `invoke()` assignment) only catches
 * removals + breaking changes, not additive drift.
 *
 * Pattern: `Eq<X, Y>` mutual-assignability invariant — same trick as
 * `bridge-contract-types.test.ts` (the 3-mirror drift catcher).
 * Failures surface during `turbo run typecheck` at the literal `true`
 * assignment, not just at `bun test` execution time.
 */
import { describe, expect, test } from 'bun:test';
import type {
  AuthEvent,
  AuthReposResponse,
  AuthStatusResponse,
  RawCloneEvent,
} from '@inkeep/open-knowledge-server';
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

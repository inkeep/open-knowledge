import { describe, expect, test } from 'vitest';
import { createConcurrencyGuard } from '../local-op-security.ts';
import type { AuthEvent } from '../local-ops/types.ts';
import { loggerFactory } from '../logger.ts';
import type { SyncEngine } from '../sync-engine.ts';
import { createLocalOpRoutes, resumeSyncOnAuthEvent } from './local-op-routes.ts';

const LOCAL_OP_PATHS = [
  '/api/local-op/clone',
  '/api/local-op/ok-init',
  '/api/local-op/auth/login',
  '/api/local-op/auth/status',
  '/api/local-op/auth/pat',
  '/api/local-op/auth/gh-login',
  '/api/local-op/auth/cancel',
  '/api/local-op/auth/repos',
  '/api/local-op/auth/signout',
  '/api/local-op/auth/set-identity',
  '/api/local-op/embeddings/set-key',
  '/api/local-op/embeddings/clear-key',
  '/api/local-op/embeddings/test',
];

function buildGroup() {
  return createLocalOpRoutes({
    projectDir: undefined,
    contentDir: '/tmp/ok-local-op-routes-test',
    log: loggerFactory.getLogger('test'),
    checkLocalOpSecurity: () => true,
    localOpCliArgs: ['open-knowledge'],
    localOpGuard: createConcurrencyGuard(),
    getSyncEngine: undefined,
    authStreamHeartbeatMs: undefined,
    embeddingsSecretsFile: undefined,
    readSemanticProviderConfig: undefined,
    semanticSearch: undefined,
  });
}

describe('createLocalOpRoutes table', () => {
  test('claims the namespace with a single wildcard and resolves all thirteen members', () => {
    const group = buildGroup();
    expect([...group.paths]).toEqual(['/api/local-op/*']);
    for (const path of LOCAL_OP_PATHS) {
      const resolution = group.table.resolve(path);
      expect(resolution?.template, path).toBe(path);
      expect(resolution?.dispatch, path).toBeDefined();
    }
  });

  test('every registered member is mutating (prefix-family membership)', () => {
    const { table } = buildGroup();
    for (const path of LOCAL_OP_PATHS) {
      expect(table.isMutating(path), path).toBe(true);
    }
  });

  test('an unregistered member is owned by the namespace leg, 404-bound, and mutating by default', () => {
    const { table } = buildGroup();
    const resolution = table.resolve('/api/local-op/some-future-op');
    expect(resolution).not.toBeNull();
    expect(resolution?.template).toBe('/api/local-op/:op');
    expect(resolution?.dispatch).toBeUndefined();
    expect(table.isMutating('/api/local-op/some-future-op')).toBe(true);
  });

  test('a bare-prefix sibling outside the family is not owned and not mutating', () => {
    const { table } = buildGroup();
    expect(table.resolve('/api/local-op-status')).toBeNull();
    expect(table.isMutating('/api/local-op-status')).toBe(false);
  });
});

describe('resumeSyncOnAuthEvent (reconnect → resume wiring)', () => {
  const makeEngineStub = (impl?: () => Promise<void>) => {
    const calls: number[] = [];
    const refreshCalls: number[] = [];
    const engine = {
      notifyCredentialsChanged: () => {
        calls.push(Date.now());
        return impl ? impl() : Promise.resolve();
      },
      refreshPushPermission: () => {
        refreshCalls.push(Date.now());
        return Promise.resolve(null);
      },
    } as unknown as SyncEngine;
    return { engine, calls, refreshCalls, getSyncEngine: () => engine };
  };

  const completeEvent: AuthEvent = { type: 'complete', host: 'github.com', login: 'octocat' };
  const verificationEvent: AuthEvent = {
    type: 'verification',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
  };
  const errorEvent: AuthEvent = { type: 'error', message: 'denied' };

  test('a complete event resumes sync AND re-probes push permission', () => {
    const stub = makeEngineStub();
    resumeSyncOnAuthEvent(completeEvent, stub.getSyncEngine);
    expect(stub.calls.length).toBe(1);
    expect(stub.refreshCalls.length).toBe(1);
  });

  test('non-complete events do not resume sync or re-probe', () => {
    const stub = makeEngineStub();
    resumeSyncOnAuthEvent(verificationEvent, stub.getSyncEngine);
    resumeSyncOnAuthEvent(errorEvent, stub.getSyncEngine);
    expect(stub.calls.length).toBe(0);
    expect(stub.refreshCalls.length).toBe(0);
  });

  test('absent getSyncEngine is a no-op (engine dormant / not yet constructed)', () => {
    expect(() => resumeSyncOnAuthEvent(completeEvent, undefined)).not.toThrow();
  });

  test('a null engine is a no-op', () => {
    expect(() => resumeSyncOnAuthEvent(completeEvent, () => null)).not.toThrow();
  });

  test('a rejected notifyCredentialsChanged is swallowed (best-effort)', async () => {
    const stub = makeEngineStub(() => Promise.reject(new Error('boom')));
    expect(() => resumeSyncOnAuthEvent(completeEvent, stub.getSyncEngine)).not.toThrow();
    expect(stub.calls.length).toBe(1);
    await Promise.resolve();
  });
});

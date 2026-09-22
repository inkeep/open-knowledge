import { describe, expect, test } from 'vitest';
import {
  V1_CODES,
  V1_RESULT_KIND_BY_CODE,
  type V1Document,
  v1ExitCode,
  v1Result,
} from './supervision-json-v1.ts';

describe('v1 result contract', () => {
  test('every command code has a stable kind and exit class', () => {
    const expected = {
      status: {
        observed: ['success', 0],
        'project-unavailable': ['error', 1],
        'operation-failed': ['error', 1],
      },
      ps: {
        inventoried: ['success', 0],
        'discovery-failed': ['error', 1],
        'operation-failed': ['error', 1],
      },
      stop: {
        signalled: ['success', 0],
        'already-stopped': ['no-op', 0],
        'target-not-found': ['no-op', 0],
        'clients-connected': ['refused', 1],
        'ownership-unverified': ['refused', 1],
        'signal-failed': ['error', 1],
        'partially-signalled': ['partial', 1],
        'ambiguous-target': ['refused', 1],
        'project-unavailable': ['error', 1],
        'operation-failed': ['error', 1],
      },
      clean: {
        'stale-removed': ['success', 0],
        'nothing-to-clean': ['no-op', 0],
        'live-retained': ['no-op', 0],
        'ownership-unverified': ['refused', 1],
        'read-failed': ['error', 1],
        'remove-failed': ['error', 1],
        'partially-cleaned': ['partial', 1],
        'project-unavailable': ['error', 1],
        'operation-failed': ['error', 1],
      },
    } as const;

    for (const command of ['status', 'ps', 'stop', 'clean'] as const) {
      expect(V1_CODES[command]).toEqual(Object.keys(expected[command]));
      for (const code of V1_CODES[command]) {
        const result = v1Result(command, code);
        expect([result.kind, v1ExitCode(result.kind)]).toEqual(
          expected[command][code as keyof (typeof expected)[typeof command]],
        );
        expect(result.detail).toBeNull();
        expect(V1_RESULT_KIND_BY_CODE[code]).toBe(result.kind);
      }
    }
    expect(v1Result('stop', 'clients-connected', 'Two clients remain.')).toEqual({
      kind: 'refused',
      code: 'clients-connected',
      detail: 'Two clients remain.',
    });
  });

  test('all command envelopes retain required nullable fields', () => {
    const documents: V1Document[] = [
      {
        schemaVersion: 1,
        command: 'status',
        result: v1Result('status', 'project-unavailable'),
        project: { root: null, resolution: 'unavailable' },
        server: {
          lock: { path: null, state: 'unknown' },
          process: null,
          alive: null,
          identity: null,
          runtimeVersion: null,
          protocolVersion: null,
          capabilities: null,
          launchKind: null,
          readiness: { status: 'unknown', checkedAt: null, degraded: [] },
          runtime: null,
        },
      },
      {
        schemaVersion: 1,
        command: 'ps',
        result: v1Result('ps', 'inventoried'),
        servers: [],
      },
      {
        schemaVersion: 1,
        command: 'stop',
        result: v1Result('stop', 'project-unavailable'),
        target: { kind: 'project', value: null, projectRoot: null },
        force: false,
        targets: [],
      },
      {
        schemaVersion: 1,
        command: 'clean',
        result: v1Result('clean', 'project-unavailable'),
        project: { root: null, resolution: 'unavailable' },
        targets: [],
      },
    ];

    expect(
      documents.map(({ schemaVersion, command, result }) => [schemaVersion, command, result]),
    ).toEqual([
      [1, 'status', { kind: 'error', code: 'project-unavailable', detail: null }],
      [1, 'ps', { kind: 'success', code: 'inventoried', detail: null }],
      [1, 'stop', { kind: 'error', code: 'project-unavailable', detail: null }],
      [1, 'clean', { kind: 'error', code: 'project-unavailable', detail: null }],
    ]);
    expect(documents[0]).toHaveProperty('server.process', null);
    expect(documents[0]).toHaveProperty('server.readiness.checkedAt', null);
    expect(documents[1]).toHaveProperty('servers');
    expect(documents[2]).toHaveProperty('targets');
    expect(documents[3]).toHaveProperty('project.root', null);
  });
});

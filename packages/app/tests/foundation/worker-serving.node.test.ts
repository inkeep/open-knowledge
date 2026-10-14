import { describe, expect, test } from 'vitest';
import {
  E2E_SERVING_ENV,
  PREBUILT_APP_ENV,
  workerServingFor,
  workerServingKind,
} from '../stress/_helpers/prebuilt/prebuilt-serving.ts';
import { PRODUCTION_SHELL_ENV } from '../stress/_helpers/production-shell-server.ts';

const ENDPOINT = { host: '127.0.0.1', candidatePort: 41234 } as const;
const PREBUILT_INVOCATION = { [E2E_SERVING_ENV]: 'prebuilt', [PREBUILT_APP_ENV]: '/tmp/prebuilt' };

describe('the serving a worker starts', () => {
  test('a production-shell opt-in in the worker env wins over an invocation that serves the prebuilt DEV app', () => {
    const serving = workerServingFor(
      { [PRODUCTION_SHELL_ENV]: '1' },
      PREBUILT_INVOCATION,
      ENDPOINT,
    );
    expect(serving.kind).toBe('production-shell');
    expect(workerServingKind({ [PRODUCTION_SHELL_ENV]: '1' }, PREBUILT_INVOCATION)).toBe(
      'production-shell',
    );
  });

  test('a production-shell opt-in in the invocation env applies when the worker env names none', () => {
    expect(workerServingFor({}, { [PRODUCTION_SHELL_ENV]: '1' }, ENDPOINT).kind).toBe(
      'production-shell',
    );
  });

  test('the production shell launches ok start on the endpoint the worker requested', () => {
    const serving = workerServingFor({ [PRODUCTION_SHELL_ENV]: '1' }, {}, ENDPOINT);
    if (serving.kind !== 'production-shell') throw new Error(`served ${serving.kind}`);
    const { args } = serving.launch;
    expect(args[1]).toBe('start');
    expect(args[args.indexOf('--port') + 1]).toBe('41234');
    expect(args[args.indexOf('--bind') + 1]).toBe('127.0.0.1');
  });

  test('without the opt-in the worker serves what the invocation names', () => {
    expect(workerServingFor({}, PREBUILT_INVOCATION, ENDPOINT)).toEqual({
      kind: 'prebuilt',
      outputDir: '/tmp/prebuilt',
    });
    expect(workerServingFor({ [PRODUCTION_SHELL_ENV]: '0' }, {}, ENDPOINT)).toEqual({
      kind: 'dev-server',
    });
    expect(workerServingKind({}, PREBUILT_INVOCATION)).toBe('prebuilt');
  });
});

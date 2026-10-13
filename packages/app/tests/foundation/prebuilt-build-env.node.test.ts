import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PREBUILT_OUT_DIR_ENV } from '../../src/build/prebuilt-dev-contract';
import { prebuiltBuildStep, runBuildStep } from '../stress/_helpers/prebuilt/prebuilt-dev-build';

const RECORD_ENV = `
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify(process.env));
`;

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the environment of the prebuilt DEV app build', () => {
  test('no VITE_ variable of the shell reaches the build, while the rest of its environment does', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-prebuilt-env-'));
    roots.push(root);
    const script = join(root, 'record-env.mjs');
    const recorded = join(root, 'env.json');
    writeFileSync(script, RECORD_ENV);
    vi.stubEnv('VITE_OTEL_ENABLED', 'true');
    vi.stubEnv('VITE_OK_PERF_INSTRUMENT', '1');
    vi.stubEnv('OK_PREBUILT_ENV_PROBE', 'kept');
    const distDir = join(root, 'dist');

    await runBuildStep({
      ...prebuiltBuildStep(distDir),
      command: process.execPath,
      args: [script, recorded],
    });

    const env = JSON.parse(readFileSync(recorded, 'utf8')) as Record<string, string>;
    expect(Object.keys(env).filter((name) => name.startsWith('VITE_'))).toEqual([]);
    expect(env).toMatchObject({
      OK_PREBUILT_ENV_PROBE: 'kept',
      NODE_ENV: 'development',
      [PREBUILT_OUT_DIR_ENV]: distDir,
    });
  });
});

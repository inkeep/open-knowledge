import { E2E_SERVING_ENV, PREBUILT_APP_ENV } from '../prebuilt/prebuilt-serving.ts';
import { REUSE_RUN_ENV, REUSE_SOCKET_ENV } from '../reuse/lease-protocol.ts';

const OUTER_RUN_SERVER_ENV = [
  REUSE_SOCKET_ENV,
  REUSE_RUN_ENV,
  E2E_SERVING_ENV,
  PREBUILT_APP_ENV,
] as const;

export function createNestedPlaywrightEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const name of OUTER_RUN_SERVER_ENV) delete inherited[name];
  const env = { ...inherited, ...overrides };
  delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  delete env.PLAYWRIGHT_JSON_OUTPUT_NAME;
  delete env.PLAYWRIGHT_JSON_OUTPUT_DIR;
  return env;
}

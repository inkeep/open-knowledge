import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import {
  releaseTestAuthorityRegistry,
  testAuthorityRegistryPath,
} from './server-authority-registry.test-helper.ts';

const home = join(dirname(testAuthorityRegistryPath), 'home');
if (process.env.COREPACK_HOME === undefined) {
  process.env.COREPACK_HOME = join(
    process.env.XDG_CACHE_HOME ??
      process.env.LOCALAPPDATA ??
      join(homedir(), process.platform === 'win32' ? 'AppData/Local' : '.cache'),
    'node/corepack',
  );
}
process.env.HOME = home;
process.env.USERPROFILE = home;

beforeAll(() => {
  mkdirSync(home, { recursive: true });
});

afterAll(releaseTestAuthorityRegistry);

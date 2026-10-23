import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import {
  releaseTestAuthorityRegistry,
  testAuthorityRegistryPath,
} from './server-authority-registry.test-helper.ts';

const home = join(dirname(testAuthorityRegistryPath), 'home');
process.env.HOME = home;
process.env.USERPROFILE = home;

beforeAll(() => {
  mkdirSync(home, { recursive: true });
});

afterAll(releaseTestAuthorityRegistry);

import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { readDeclaredGitHubHosts } from './git-context.ts';
import { declareGitHubHosts, useIsolatedHome } from './git-host-declarations.test-helper.ts';

const home = useIsolatedHome();
vi.stubEnv('OK_CHANNEL', 'beta');
afterEach(() => vi.unstubAllEnvs());

test('reads declarations from the isolated home', () => {
  const host = `fixture-${randomUUID()}.invalid`;
  declareGitHubHosts(home(), host);
  expect([...readDeclaredGitHubHosts()]).toEqual([host]);
});

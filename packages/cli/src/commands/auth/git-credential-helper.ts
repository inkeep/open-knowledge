import { flushFileLogger } from '@inkeep/open-knowledge-server/file-logger';
import { createTokenStore } from '../../auth/token-store.ts';
import { initCliLogger } from '../../cli-logger.ts';
import { getGitCredential } from './git-credential-get.ts';

export async function runGitCredentialGet(): Promise<number> {
  const log = initCliLogger({ command: 'auth', cwd: process.cwd() });
  const exitCode = await getGitCredential({
    getTokenStore: (diag) => createTokenStore(undefined, diag),
    log,
  });
  await flushFileLogger(log);
  return exitCode;
}

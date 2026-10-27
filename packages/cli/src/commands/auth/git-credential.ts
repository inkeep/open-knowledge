import { flushFileLogger } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import type { Logger as PinoLoggerInstance } from 'pino';
import type { TokenStore, TokenStoreDiagnostics } from '../../auth/token-store.ts';
import { getGitCredential } from './git-credential-get.ts';
import {
  GIT_CREDENTIAL_OPERATIONS,
  type GitCredentialOperation,
  handleCredentialUpdate,
} from './git-credential-operation.ts';

const OPERATION_DESCRIPTIONS: Record<GitCredentialOperation, string> = {
  get: 'Lookup credentials from TokenStore (called by git)',
  store: 'Accept a credential git approved, without saving it (called by git)',
  erase: 'Accept a credential git rejected, without removing it (called by git)',
};

export function gitCredentialCommand(
  getTokenStore: (diag?: TokenStoreDiagnostics) => Promise<TokenStore>,
  getLog?: () => PinoLoggerInstance | undefined,
): Command {
  const cmd = new Command('git-credential');
  cmd.description('Git credential helper (git credential-helper protocol)');

  for (const operation of GIT_CREDENTIAL_OPERATIONS) {
    cmd
      .command(operation)
      .description(OPERATION_DESCRIPTIONS[operation])
      .action(async () => {
        const log = getLog?.();
        const exitCode =
          operation === 'get'
            ? await getGitCredential({ getTokenStore, log })
            : await handleCredentialUpdate(operation, process.stdin);
        await flushFileLogger(log);
        process.exit(exitCode);
      });
  }

  return cmd;
}

import { flushFileLogger } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import type { Logger as PinoLoggerInstance } from 'pino';
import type { TokenStore, TokenStoreDiagnostics } from '../../auth/token-store.ts';
import { handleCredentialGet, type KeychainReadInfo } from './git-credential-get.ts';

export function gitCredentialCommand(
  getTokenStore: (diag?: TokenStoreDiagnostics) => Promise<TokenStore>,
  getLog?: () => PinoLoggerInstance | undefined,
): Command {
  const cmd = new Command('git-credential');
  cmd.description('Git credential helper (git credential-helper protocol)');

  cmd
    .command('get')
    .description('Lookup credentials from TokenStore (called by git)')
    .action(async () => {
      const log = getLog?.();
      try {
        let lastKeychainRead: KeychainReadInfo | undefined;
        const store = await getTokenStore({
          onKeychainRead: (info) => {
            lastKeychainRead = info;
          },
          onBackendSelected: (info) => {
            if (info.backend === 'file' && info.reason) {
              log?.warn({ backend: 'file', reason: info.reason }, '[auth] token storage fallback');
            }
          },
        });
        const exitCode = await handleCredentialGet(process.stdin, process.stdout, store, {
          log,
          getDiag: () => lastKeychainRead,
        });
        await flushFileLogger(log);
        process.exit(exitCode);
      } catch (err) {
        log?.error({ err }, '[auth] git-credential get: unexpected error');
        await flushFileLogger(log);
        process.exit(1);
      }
    });

  return cmd;
}

import { Command } from 'commander';
import type { Logger as PinoLoggerInstance } from 'pino';
import { createTokenStore, type TokenStoreDiagnostics } from '../../auth/token-store.ts';
import { gitCredentialCommand } from './git-credential.ts';
import { loginCommand } from './login.ts';
import { patCommand } from './pat.ts';
import { reposCommand } from './repos.ts';
import { signoutCommand } from './signout.ts';
import { statusCommand } from './status.ts';

/**
 * Build the `auth` command group.
 * Subcommands: login, status, repos, signout, pat, git-credential
 *
 * `getLog` returns the CLI file logger so `git-credential get` (invoked by git
 * on every fetch/push) can persist credential hit/miss diagnostics to
 * `~/.ok/logs/`; the other subcommands run interactively and don't need it.
 */
export function authCommand(getLog?: () => PinoLoggerInstance | undefined): Command {
  const cmd = new Command('auth');
  cmd.description('GitHub authentication management');

  const getTokenStore = (diag?: TokenStoreDiagnostics) => createTokenStore(undefined, diag);

  cmd.addCommand(loginCommand(getTokenStore));
  cmd.addCommand(statusCommand(getTokenStore));
  cmd.addCommand(reposCommand(getTokenStore));
  cmd.addCommand(signoutCommand());
  cmd.addCommand(patCommand(getTokenStore));
  cmd.addCommand(gitCredentialCommand(getTokenStore, getLog));

  return cmd;
}

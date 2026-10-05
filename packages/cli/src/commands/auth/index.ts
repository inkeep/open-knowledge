import { Command } from 'commander';
import type { Logger as PinoLoggerInstance } from 'pino';
import { createTokenStore, type TokenStoreDiagnostics } from '../../auth/token-store.ts';
import { gitCredentialCommand } from './git-credential.ts';
import { loginCommand } from './login.ts';
import { patCommand } from './pat.ts';
import { reposCommand } from './repos.ts';
import { signoutCommand } from './signout.ts';
import { statusCommand } from './status.ts';
import { tokenCommand } from './token.ts';

export function authCommand(getLog?: () => PinoLoggerInstance | undefined): Command {
  const cmd = new Command('auth');
  cmd.description('Git host authentication management');

  const getTokenStore = (diag?: TokenStoreDiagnostics) => createTokenStore(undefined, diag);

  cmd.addCommand(loginCommand(getTokenStore));
  cmd.addCommand(statusCommand(getTokenStore));
  cmd.addCommand(reposCommand(getTokenStore));
  cmd.addCommand(signoutCommand());
  cmd.addCommand(patCommand(getTokenStore));
  cmd.addCommand(tokenCommand(getTokenStore));
  cmd.addCommand(gitCredentialCommand(getTokenStore, getLog));

  return cmd;
}

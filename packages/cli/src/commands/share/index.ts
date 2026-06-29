
import { Command } from 'commander';
import { createTokenStore } from '../../auth/token-store.ts';
import { shareNameCheckCommand } from './name-check.ts';
import { shareOwnersCommand } from './owners.ts';
import { sharePublishCommand } from './publish.ts';

export function shareCommand(): Command {
  const cmd = new Command('share');
  cmd.description('Sharing flow operations (owners, name-check, publish)');

  const getTokenStore = () => createTokenStore();

  cmd.addCommand(shareOwnersCommand(getTokenStore));
  cmd.addCommand(shareNameCheckCommand(getTokenStore));
  cmd.addCommand(sharePublishCommand(getTokenStore));

  return cmd;
}

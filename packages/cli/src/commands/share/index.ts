/**
 * `open-knowledge share` — subcommand group driving the Publish-to-GitHub
 * flow used by the editor's Share button when a project has no remote
 *. All three subcommands emit single-line JSON events when
 * `--json` is passed so the server-side spawner can parse without
 * stream-framing.
 */

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

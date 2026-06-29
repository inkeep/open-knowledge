
import { Command } from 'commander';
import { sharingShareCommand } from './share.ts';
import { sharingStatusCommand } from './status.ts';
import { sharingUnshareCommand } from './unshare.ts';

export function sharingCommand(): Command {
  const cmd = new Command('config-sharing');
  cmd.description(
    "Manage OpenKnowledge's git-sharing mode (share OK config with the team, or keep local-only on this machine)",
  );
  cmd.addCommand(sharingShareCommand());
  cmd.addCommand(sharingUnshareCommand());
  cmd.addCommand(sharingStatusCommand());
  return cmd;
}

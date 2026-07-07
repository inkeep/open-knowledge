/**
 * `ok config-sharing` — manage whether OK config files are committed
 * alongside content (`shared`, the default) or kept out of git via
 * `.git/info/exclude` (`local-only`).
 *
 * Three subcommands:
 *   ok config-sharing share     — switch to shared (committed) mode
 *   ok config-sharing unshare   — switch to local-only mode (runs the
 *                                 tracked-files safety check first; refuses
 *                                 when an OK artifact is already tracked)
 *   ok config-sharing status    — print the current mode + excluded paths
 *
 * The namespace is `config-sharing`, not `sharing`: `ok share` already names
 * the Publish-to-GitHub group (`ok share owners`, `name-check`, `publish`,
 * driven by the editor's Share button), so a bare `ok sharing` reads as a
 * near-typo of it. `config-sharing` says what the toggle governs — whether
 * OK's generated config travels with the repo — and leaves the `share` verb
 * to the publish flow. Room remains for future scope (per-artifact toggles,
 * app-scoped defaults) under the same namespace.
 */

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

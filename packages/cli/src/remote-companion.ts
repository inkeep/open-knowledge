#!/usr/bin/env node

/**
 * Minimal entry point installed by Desktop on an SSH machine.
 *
 * This is intentionally not a second user-facing `ok` installation. Desktop
 * content-addresses the bundled file under `~/.ok/remote/servers/` and invokes
 * it through the remote machine's existing Node.js runtime. Keeping the entry
 * to machine-only commands avoids changing PATH or installing npm
 * packages on the user's behalf.
 */

import {
  formatRemoteErrorLine,
  formatRemoteInspectLine,
  formatRemoteTerminalConsentLine,
  parseRemoteCompanionCommand,
  parseRemoteCompanionNonce,
  runRemoteServe,
  waitForRemoteTerminalConsent,
} from './commands/remote.ts';
import { loadConfig } from './config/loader.ts';
import { PACKAGE_VERSION } from './constants.ts';
import {
  inspectRemoteProject,
  prepareRemoteProject,
  RemoteCompanionError,
  validateRemoteContentDirectory,
} from './remote-project-bootstrap.ts';

// Remote editor sessions must not rewrite editor integrations or global skill
// projections on the SSH host merely because a project was opened. The normal
// server boot path already owns this documented opt-out.
process.env.OK_RECLAIM_DISABLE = '1';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const nonce = parseRemoteCompanionNonce(args);
  responseNonce = nonce;
  const command = parseRemoteCompanionCommand(args.slice(2));

  if (command.name === 'inspect') {
    process.stdout.write(formatRemoteInspectLine(nonce, inspectRemoteProject(process.cwd())));
    return;
  }

  if (command.name === 'serve') {
    const projectRoot = prepareRemoteProject(
      process.cwd(),
      command.initialize ? command.expectedPath : undefined,
    );
    process.chdir(projectRoot);
    const config = (() => {
      try {
        return loadConfig(projectRoot).config;
      } catch (cause) {
        throw new RemoteCompanionError('config-invalid', 'Project configuration is invalid.', {
          cause,
        });
      }
    })();
    const resolvedContentDir = validateRemoteContentDirectory(projectRoot, config.content.dir);
    await runRemoteServe({
      config,
      cwd: projectRoot,
      resolvedContentDir,
      nonce,
      waitForOwnerExit: command.waitForOwnerExit,
      deps: { runtimeVersion: PACKAGE_VERSION },
    });
    return;
  }

  if (command.name === 'terminal-consent') {
    const inspection = inspectRemoteProject(process.cwd());
    if (!inspection.initialized) {
      throw new RemoteCompanionError(
        'project-uninitialized',
        'The selected folder is not an OpenKnowledge project.',
      );
    }
    const allowed = await waitForRemoteTerminalConsent(inspection.projectPath);
    process.stdout.write(formatRemoteTerminalConsentLine(nonce, allowed));
  }
}

let responseNonce: string | undefined;
main().catch((error: unknown) => {
  if (responseNonce !== undefined) {
    process.stdout.write(
      formatRemoteErrorLine(
        responseNonce,
        error instanceof RemoteCompanionError ? error.code : 'startup-failed',
      ),
    );
  }
  process.exitCode = 1;
});

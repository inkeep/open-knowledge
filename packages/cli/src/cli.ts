#!/usr/bin/env node

if (process.argv.includes('--no-color')) {
  process.env.NO_COLOR = '1';
  delete process.env.FORCE_COLOR;
} else if (process.argv.includes('--color')) {
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
}

trustSystemCertificates();

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { formatIgnoredCommittedKey, humanFormat } from '@inkeep/open-knowledge-core';
import { type Config, ConfigSchema, trustSystemCertificates } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { getCliLogger, initCliLogger } from './cli-logger.ts';
import { auditCommand } from './commands/audit.ts';
import { authCommand } from './commands/auth/index.ts';
import { bugReportCommand } from './commands/bug-report.ts';
import { cleanCommand } from './commands/clean.ts';
import { cloneCommand } from './commands/clone.ts';
import { configCommand, shouldAnnounceRemovedKeys } from './commands/config.ts';
import { coworkCommand } from './commands/cowork.ts';
import { deinitCommand } from './commands/deinit.ts';
import { createRealDetectDeps, detectDesktop, launchDesktop } from './commands/desktop-dispatch.ts';
import { diagnoseCommand } from './commands/diagnose.ts';
import { embeddingsCommand } from './commands/embeddings/index.ts';
import { initCommand } from './commands/init.ts';
import { lintCommand } from './commands/lint.ts';
import { mcpCommand } from './commands/mcp.ts';
import { migrateCommand } from './commands/migrate.ts';
import { openCommand } from './commands/open.ts';
import { previewCommand } from './commands/preview.ts';
import { psCommand } from './commands/ps.ts';
import { pullCommand } from './commands/pull.ts';
import { pushCommand } from './commands/push.ts';
import { repairSkillsCommand } from './commands/repair-skills.ts';
import { seedCommand } from './commands/seed.ts';
import { shareCommand } from './commands/share/index.ts';
import { sharingCommand } from './commands/sharing/index.ts';
import { isFileishTarget, resolveRootDispatch } from './commands/single-file-dispatch.ts';
import { createRealSingleFileOpenDeps, runSingleFileOpen } from './commands/single-file-open.ts';
import { skillsCommand } from './commands/skills.ts';
import { runStartCommand, startCommand } from './commands/start.ts';
import { statusCommand } from './commands/status.ts';
import { stopCommand } from './commands/stop.ts';
import { syncCommand } from './commands/sync.ts';
import { uninstallCommand } from './commands/uninstall.ts';
import { PACKAGE_VERSION } from './constants.ts';
import { loadConfig } from './index.ts';
import { recordInvocationCwd, resolveProjectAnchor } from './project-anchor.ts';
import { buildVersionNotice } from './version-notice.ts';

const program = new Command();

let resolvedConfig: Config;

program
  .name('open-knowledge')
  .description('Local-first knowledge base with CRDT collaboration')
  .usage('[options] [file | command]')
  .version(buildVersionNotice(PACKAGE_VERSION))
  .option('--cwd <path>', 'Working directory')
  .option(
    '--log-level <level>',
    'Log level: silent, error, warn, info (default), debug, trace',
    'info',
  )
  .option('--no-color', 'Disable color output')
  .option('--color', 'Force color output')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    const cwd = opts.cwd as string | undefined;
    if (cwd !== undefined) {
      process.chdir(cwd);
    }

    if (program.getOptionValueSource('logLevel') === 'cli') {
      const level = String(program.opts().logLevel);
      process.env.LOG_LEVEL = level;
      process.env.OK_CONSOLE_LEVEL = level;
    }

    const subcommandName = thisCommand.args?.[0];
    const anchorRoot = resolveProjectAnchor(subcommandName, process.cwd());
    if (anchorRoot !== null) {
      recordInvocationCwd(process.cwd());
      process.chdir(anchorRoot);
      console.error(`[ok] Using OpenKnowledge project at ${anchorRoot}`);
    }

    let config: Config;
    try {
      const loaded = loadConfig(anchorRoot ?? cwd);
      config = loaded.config;
      if (shouldAnnounceRemovedKeys(subcommandName)) {
        for (const diagnostic of loaded.diagnostics) {
          if (diagnostic.code !== 'REMOVED_KEY') continue;
          console.error(`[ok] ${humanFormat(diagnostic)}`);
        }
      }
      for (const key of loaded.ignoredCommittedKeys) {
        console.error(`[ok] ${formatIgnoredCommittedKey(key)}`);
      }
    } catch (err) {
      if (subcommandName === 'uninstall' || subcommandName === 'deinit') {
        console.error(
          `[ok] project config could not be loaded; ${subcommandName} will use defaults: ${err instanceof Error ? err.message : String(err)}`,
        );
        config = ConfigSchema.parse({});
      } else {
        throw err;
      }
    }
    resolvedConfig = config;

    const commandName = thisCommand.args?.[0] ?? thisCommand.name() ?? 'cli';
    initCliLogger({
      command: commandName,
      cwd: process.cwd(),
      configuredProjectName: (config as { project?: { name?: string } }).project?.name ?? undefined,
    });
  });

program.action(async () => {
  const decision = detectDesktop(createRealDetectDeps());

  if (decision.available) {
    launchDesktop({ spawn }, decision);
    return;
  }

  await runStartCommand(resolvedConfig, {});
});

const start = startCommand(() => resolvedConfig);
program.addCommand(start);

const mcp = mcpCommand(() => resolvedConfig);
program.addCommand(mcp);

program.addCommand(initCommand());

program.addCommand(seedCommand());

program.addCommand(migrateCommand());

program.addCommand(coworkCommand(), { hidden: true });

program.addCommand(repairSkillsCommand());

program.addCommand(skillsCommand());

const preview = previewCommand(() => resolvedConfig);
program.addCommand(preview);

program.addCommand(lintCommand(() => resolvedConfig));

program.addCommand(auditCommand(() => resolvedConfig));

const uiTombstone = new Command('ui')
  .description('Removed: the editor UI is served by `ok start`')
  .allowUnknownOption()
  .allowExcessArguments()
  .argument('[args...]')
  .action(() => {
    console.error(
      '`ok ui` was removed — the editor UI is served by the project server. Run `ok start` instead.',
    );
    process.exit(1);
  });
program.addCommand(uiTombstone, { hidden: true });

program.addCommand(openCommand());

program.addCommand(stopCommand(() => resolvedConfig));
program.addCommand(cleanCommand(() => resolvedConfig));
program.addCommand(statusCommand(() => resolvedConfig));

program.addCommand(deinitCommand());
program.addCommand(uninstallCommand());

program.addCommand(psCommand());

program.addCommand(diagnoseCommand());

program.addCommand(bugReportCommand());

program.addCommand(configCommand());

program.addCommand(authCommand(getCliLogger));

program.addCommand(embeddingsCommand());

program.addCommand(cloneCommand(() => resolvedConfig));

program.addCommand(syncCommand(() => resolvedConfig));
program.addCommand(pushCommand(() => resolvedConfig));
program.addCommand(pullCommand(() => resolvedConfig));

program.addCommand(shareCommand());

program.addCommand(sharingCommand());

program.addHelpText(
  'after',
  `
Examples:
  ok                       Launch the desktop app (or start a local server if it isn't installed)
  ok notes.md              Open a single markdown file in the editor
  ok ./specs/foo/SPEC.md   Open a file inside a project, focused on that doc
  ok open ./start.md       Open a file whose name collides with a subcommand`,
);

{
  const dispatch = resolveRootDispatch(process.argv.slice(2), {
    knownSubcommands: new Set(program.commands.map((c) => c.name())),
    cwd: process.cwd(),
    isFileish: isFileishTarget,
    resolvePath: (base, token) => resolve(base, token),
  });
  if (dispatch !== null) {
    initCliLogger({ command: 'open-file', cwd: process.cwd() });
    getCliLogger()?.info(
      { file: dispatch.absPath, projectOverride: dispatch.projectRoot },
      'single-file open dispatch',
    );
    const code = await runSingleFileOpen(dispatch.absPath, createRealSingleFileOpenDeps(), {
      projectRoot: dispatch.projectRoot ?? undefined,
    });
    process.exit(code);
  }
}

await program.parseAsync(process.argv, { from: 'node' });

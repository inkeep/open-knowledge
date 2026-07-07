#!/usr/bin/env node

// Propagate --no-color/--color argv flags to env vars for libraries in the
// dependency tree that check NO_COLOR/FORCE_COLOR. picocolors itself checks
// argv directly at module evaluation time, but other libraries may only
// read env vars. --no-color always wins when both flags are present,
// matching picocolors' own precedence and no-color.org convention.

if (process.argv.includes('--no-color')) {
  process.env.NO_COLOR = '1';
  delete process.env.FORCE_COLOR;
} else if (process.argv.includes('--color')) {
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
}

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { type Config, ConfigSchema } from '@inkeep/open-knowledge-server';
/**
 * CLI entry point for @inkeep/open-knowledge.
 *
 * Commander.js v14. `ok` (no positional args) auto-detects whether the
 * desktop Electron app is available + interactive on macOS — when both
 * hold, hands off to the desktop and exits; otherwise invokes the
 * `start` command (server + browser).
 *
 * Config loaded via preAction hook: CLI > ENV > project > user > Zod defaults.
 */
import { Command } from 'commander';
import { authCommand } from './commands/auth/index.ts';
import { bugReportCommand } from './commands/bug-report.ts';
import { cleanCommand } from './commands/clean.ts';
import { cloneCommand } from './commands/clone.ts';
import { configCommand } from './commands/config.ts';
import { coworkCommand } from './commands/cowork.ts';
import { deinitCommand } from './commands/deinit.ts';
import { createRealDetectDeps, detectDesktop, launchDesktop } from './commands/desktop-dispatch.ts';
import { diagnoseCommand } from './commands/diagnose.ts';
import { embeddingsCommand } from './commands/embeddings/index.ts';
import { initCommand } from './commands/init.ts';
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
import {
  decideSingleFileTarget,
  isFileishTarget,
  scanRootArgv,
} from './commands/single-file-dispatch.ts';
import { createRealSingleFileOpenDeps, runSingleFileOpen } from './commands/single-file-open.ts';
import { skillsCommand } from './commands/skills.ts';
import { runStartCommand, startCommand } from './commands/start.ts';
import { statusCommand } from './commands/status.ts';
import { stopCommand } from './commands/stop.ts';
import { syncCommand } from './commands/sync.ts';
import { uiCommand } from './commands/ui.ts';
import { uninstallCommand } from './commands/uninstall.ts';
import { PACKAGE_VERSION } from './constants.ts';
import { loadConfig } from './index.ts';
import { recordInvocationCwd, resolveProjectAnchor } from './project-anchor.ts';
import { buildVersionNotice } from './version-notice.ts';

const program = new Command();

import { createFileLogger } from '@inkeep/open-knowledge-server';

import type { Logger as PinoLoggerInstance } from 'pino';

// Shared state populated by preAction hook
let resolvedConfig: Config;
let cliLogger: PinoLoggerInstance | undefined;

export function getCliLogger(): PinoLoggerInstance | undefined {
  return cliLogger;
}

program
  .name('open-knowledge')
  .description('Local-first knowledge base with CRDT collaboration')
  // Surface the two zero-subcommand entry points in the usage line: bare `ok`
  // (desktop launch / `ok start` fallback) and `ok <file>` (open a markdown
  // file directly). Both are handled before Commander's subcommand dispatch.
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

    // Apply an explicit `--log-level`: wire it to LOG_LEVEL (file sink + base
    // logger level) AND OK_CONSOLE_LEVEL (stdout stream) so it's the
    // discoverable "show me everything" toggle now that interactive `ok start`
    // is quiet by default. Only when EXPLICITLY provided — the 'info' default
    // must not pin the env, or it would defeat the quiet-by-default behavior in
    // `runStartCommand`. `getOptionValueSource` returns 'cli' only for an
    // actually-passed flag (verified: the 'info' default reports 'default').
    if (program.getOptionValueSource('logLevel') === 'cli') {
      const level = String(program.opts().logLevel);
      process.env.LOG_LEVEL = level;
      process.env.OK_CONSOLE_LEVEL = level;
    }

    // CLI-wide project anchoring: lifecycle commands invoked from a
    // subdirectory walk up to the nearest enclosing `.ok/config.yml` (same
    // semantics as MCP `findProjectDir`, so CLI and MCP key off the same
    // `server.lock`). Must run BEFORE loadConfig — `loadConfig` reads
    // `<cwd>/.ok/config.yml` literally and does not walk, so anchoring
    // inside a command action would boot the right root with default config.
    const subcommandName = thisCommand.args?.[0];
    const anchorRoot = resolveProjectAnchor(subcommandName, process.cwd());
    if (anchorRoot !== null) {
      recordInvocationCwd(process.cwd());
      process.chdir(anchorRoot);
      // The resolved root can be a large surprise (e.g. a monorepo root with
      // `content.dir: .`) — disclose it so it's visible and correctable.
      // stderr keeps `ok mcp`'s stdout JSON-RPC stream clean.
      console.error(`[ok] Using OpenKnowledge project at ${anchorRoot}`);
    }

    // The removal verbs must run even when the project config is broken — an
    // unbootable/half-migrated project is a core reason to run them — so a
    // schema/removed-key error there degrades to schema defaults instead of
    // aborting before the command can clean up. Every other command keeps the
    // loud fail-fast so the user notices a config they can fix in place.
    let config: Config;
    try {
      config = loadConfig(anchorRoot ?? cwd).config;
    } catch (err) {
      if (subcommandName === 'uninstall' || subcommandName === 'deinit') {
        // Surface the original parse error before degrading — the user should
        // still learn their project config is broken (they may want to fix it
        // rather than remove), and an operator debugging later has the cause.
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
    cliLogger = createFileLogger({
      name: 'cli',
      project: (config as { project?: { name?: string } }).project?.name ?? undefined,
    });
    cliLogger.info({ command: commandName, cwd: process.cwd() }, 'cli command started');
  });

// `ok` (no positional args) — desktop dispatch with fallback to start.
// Bare `ok start` remains a normal subcommand (registered below without
// isDefault) so today's behavior is bit-for-bit unchanged when invoked
// explicitly. `--cwd` is honored by the preAction hook above before
// this action runs.
program.action(async () => {
  const decision = detectDesktop(createRealDetectDeps());

  if (decision.available) {
    launchDesktop({ spawn });
    return;
  }

  await runStartCommand(resolvedConfig, {});
});

// `start` subcommand — explicit invocation OR fallback target from the
// no-args dispatch above. Not the default subcommand any more (the
// program-level action handles no-args).
const start = startCommand(() => resolvedConfig);
program.addCommand(start);

// MCP command
const mcp = mcpCommand(() => resolvedConfig);
program.addCommand(mcp);

// init command — stateless terminal setup, no config needed
program.addCommand(initCommand());

// seed command — stateless content-scaffold, no config needed
program.addCommand(seedCommand());

// migrate command — stateless, filesystem-only importers (`migrate notion`).
// No config/server: operates directly on an export directory argument.
program.addCommand(migrateCommand());

// cowork command — HIDDEN + unadvertised power-user escape hatch. Builds the
// openknowledge.skill bundle and opens Claude Desktop for the manual upload
// (Chat & Cowork read a separate, isolated Skills list `ok init` can't reach).
// Registered `{ hidden: true }` so it never shows in `ok --help`, and `ok init`
// does NOT hint toward it — discovery is pull-only via the OK skill. Renamed
// from the misleading `ok install-skill`; do not re-advertise it.
program.addCommand(coworkCommand(), { hidden: true });

// repair-skills command — explicit invocation of the project + user-global
// SKILL.md reclaim sweeps. Same logic runs automatically during `ok start`;
// this command lets a user force a sweep without booting a server.
program.addCommand(repairSkillsCommand());

// skills command — project-level skill management opt-in (`ok skills manage`)
program.addCommand(skillsCommand());

// preview command — read-only content scope inspection
const preview = previewCommand(() => resolvedConfig);
program.addCommand(preview);

// ui command — serves the React editor (sibling of `start`).
const ui = uiCommand(() => resolvedConfig);
program.addCommand(ui);

// open command — open a doc in the OK Desktop app (folders open in the
// browser). The action for the no-preview-browser rung of the skill's
// capability ladder; the Claude Code CLI is the host that lands there.
program.addCommand(openCommand());

// stop / clean / status — lifecycle utilities.
program.addCommand(stopCommand(() => resolvedConfig));
program.addCommand(cleanCommand(() => resolvedConfig));
program.addCommand(statusCommand(() => resolvedConfig));

// deinit / uninstall — removal verbs (config-independent; preAction tolerates a
// broken project config for these). `deinit` reverses one project's OK
// footprint; `uninstall` reverses OK's whole outside-project footprint.
program.addCommand(deinitCommand());
program.addCommand(uninstallCommand());

// ps — global server list (config-independent).
program.addCommand(psCommand());

// diagnose — process diagnostic bundle (metadata, lsof, CPU profile).
program.addCommand(diagnoseCommand());

// bug-report — generate a redacted diagnostic zip for bug reporting.
program.addCommand(bugReportCommand());

// config command group — inspect + migrate `.ok/config.yml`. Stateless — no resolved config
// dependency; both subcommands re-load fresh from disk via core helpers.
program.addCommand(configCommand());

// auth command group — login, status, repos, signout, pat, git-credential.
// Pass the CLI file-logger getter so `git-credential get` persists credential
// hit/miss diagnostics to ~/.ok/logs/ (its stderr is captured by git, so
// stderr-only logs are otherwise lost when a sync auth failure occurs).
program.addCommand(authCommand(getCliLogger));

// embeddings command group — set-key / clear-key / status for semantic search.
// A sibling of `auth` (which is GitHub-specific); manages the embeddings
// provider key in the OS keyring + the per-machine capability status.
program.addCommand(embeddingsCommand());

// clone command — git clone + auto-start
program.addCommand(cloneCommand(() => resolvedConfig));

// sync commands — delegate to server or fall back to simple-git
program.addCommand(syncCommand(() => resolvedConfig));
program.addCommand(pushCommand(() => resolvedConfig));
program.addCommand(pullCommand(() => resolvedConfig));

// share command group — Publish-to-GitHub flow (owners, name-check, publish).
// Used by the editor's Share button via the server's /api/share/publish/* HTTP
// endpoints, which spawn this CLI as a subprocess.
program.addCommand(shareCommand());

// `config-sharing` group — `ok config-sharing share|unshare|status` toggle for
// whether OK config gets committed alongside content (`shared`) or kept out of
// git via `.git/info/exclude` (`local-only`). Distinct namespace from the
// GitHub publish `ok share owners|name-check|publish` group above.
program.addCommand(sharingCommand());

// Discoverability for the bare `ok <file>` single-file open (the dispatch
// itself is an argv pre-check below, NOT a Commander positional — see
// single-file-dispatch.ts). `ok open <file>` is the alias / escape-hatch for the
// extensionless-collision edge.
program.addHelpText(
  'after',
  `
Examples:
  ok                       Launch the desktop app (or start a local server if it isn't installed)
  ok notes.md              Open a single markdown file in the editor
  ok ./specs/foo/SPEC.md   Open a file inside a project, focused on that doc
  ok open ./start.md       Open a file whose name collides with a subcommand`,
);

// Bare `ok <file>` pre-dispatch — runs BEFORE Commander parses and BEFORE
// desktop detection. Commander treats the first operand as a subcommand
// name once subcommands are registered, so a bare `.md` operand can't be a
// reliable positional; we intercept it here instead. `ok open <file>` is
// handled too (only when the 2nd operand is a real file, leaving the existing
// ext-less `ok open <doc>` contract untouched). Everything else falls through
// to Commander unchanged.
{
  const scanned = scanRootArgv(process.argv.slice(2));
  if (!scanned.sawTerminalFlag) {
    const baseDir = scanned.cwd ? resolve(scanned.cwd) : process.cwd();
    const knownSubcommands = new Set(program.commands.map((c) => c.name()));
    const target = decideSingleFileTarget(scanned.operands, {
      knownSubcommands,
      isFileish: (t) => isFileishTarget(resolve(baseDir, t), t),
    });
    if (target !== null) {
      const code = await runSingleFileOpen(
        resolve(baseDir, target),
        createRealSingleFileOpenDeps(),
      );
      process.exit(code);
    }
  }
}

// The DMG runs this entry point under Electron with ELECTRON_RUN_AS_NODE=1.
// Commander otherwise sees process.versions.electron and treats cli.mjs as a
// positional argument by slicing argv in Electron mode.
await program.parseAsync(process.argv, { from: 'node' });

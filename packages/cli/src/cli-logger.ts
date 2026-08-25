/**
 * Process-wide holder for the CLI's pino file logger (`~/.ok/logs/cli.*.log`).
 *
 * Lives outside `cli.ts` for two reasons: the bare `ok <file>` argv
 * pre-dispatch runs BEFORE Commander's `preAction` hook and must still be
 * instrumented, and command modules (`stop.ts`) need the logger without
 * importing the entry point back (an import cycle).
 */

import { createFileLogger, findEnclosingProjectRoot } from '@inkeep/open-knowledge-server';
import type { Logger as PinoLoggerInstance } from 'pino';

let cliLogger: PinoLoggerInstance | undefined;

export function getCliLogger(): PinoLoggerInstance | undefined {
  return cliLogger;
}

/**
 * The `project` field stamped on every record. A configured project name wins;
 * otherwise the enclosing project root identifies the project the command
 * actually acted on — the previous `<no-project>` placeholder was stamped even
 * for commands run inside a project.
 */
export function resolveLogProject(cwd: string, configuredName?: string): string | undefined {
  if (configuredName !== undefined && configuredName.length > 0) return configuredName;
  try {
    return findEnclosingProjectRoot(cwd)?.rootPath;
  } catch {
    return undefined;
  }
}

export interface InitCliLoggerOptions {
  /** Subcommand name, or a synthetic name for the pre-dispatch entry points. */
  command: string;
  cwd: string;
  /** Configured `project.name`, when the command loaded a project config. */
  configuredProjectName?: string;
}

/**
 * Create (or re-create) the CLI file logger and emit the invocation record.
 * The pre-dispatch path exits before Commander runs, so exactly one of the two
 * entry points calls this per invocation.
 */
export function initCliLogger(opts: InitCliLoggerOptions): PinoLoggerInstance {
  const project = resolveLogProject(opts.cwd, opts.configuredProjectName);
  const logger = createFileLogger({ name: 'cli', project });
  cliLogger = logger;
  logger.info({ command: opts.command, cwd: opts.cwd, project }, 'cli command started');
  return logger;
}

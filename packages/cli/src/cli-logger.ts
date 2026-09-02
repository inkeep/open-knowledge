import { createFileLogger, findEnclosingProjectRoot } from '@inkeep/open-knowledge-server';
import type { Logger as PinoLoggerInstance } from 'pino';

let cliLogger: PinoLoggerInstance | undefined;

export function getCliLogger(): PinoLoggerInstance | undefined {
  return cliLogger;
}

export function resolveLogProject(cwd: string, configuredName?: string): string | undefined {
  if (configuredName !== undefined && configuredName.length > 0) return configuredName;
  try {
    return findEnclosingProjectRoot(cwd)?.rootPath;
  } catch {
    return undefined;
  }
}

export interface InitCliLoggerOptions {
  command: string;
  cwd: string;
  configuredProjectName?: string;
}

export function initCliLogger(opts: InitCliLoggerOptions): PinoLoggerInstance {
  const project = resolveLogProject(opts.cwd, opts.configuredProjectName);
  const logger = createFileLogger({ name: 'cli', project });
  cliLogger = logger;
  logger.info({ command: opts.command, cwd: opts.cwd, project }, 'cli command started');
  return logger;
}

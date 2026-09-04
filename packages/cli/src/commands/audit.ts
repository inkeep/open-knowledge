import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  clientVersionHeaders,
  type ValidationAuditResponse,
  ValidationAuditResponseSchema,
} from '@inkeep/open-knowledge-core';
import {
  type Config,
  RUNTIME_VERSION,
  readServerLock,
  resolveContentDir,
  resolveLockDir,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { getInvocationCwd } from '../project-anchor.ts';
import { formatLintReport, type LintReportInput } from './lint.ts';

interface AuditOptions {
  json?: boolean;
  errorsOnly?: boolean;
}

interface AuditIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: AuditIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const SERVER_NOT_RUNNING_MESSAGE =
  'OpenKnowledge server is not running — the links validator needs the live backlink index. ' +
  'Start it with `ok start` (or open OK Desktop) and re-run. For headless lint-only checks, use `ok lint`.';

export function auditCommand(getConfig: () => Config): Command {
  return new Command('audit')
    .description(
      'Unified validation audit (markdown lint + broken internal links) via the running project server',
    )
    .argument('[path]', 'Folder or file to audit, relative to where you run the command')
    .option('--json', 'Emit the full structured JSON response instead of formatted text')
    .option(
      '--errors-only',
      "Exit non-zero only on error-severity problems (broken links default to warnings; the project's validation.links setting can raise them to errors)",
    )
    .action(async (path: string | undefined, opts: AuditOptions) => {
      const exitCode = await runAudit(path, opts, getConfig(), process.cwd(), getInvocationCwd());
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}

export async function runAudit(
  path: string | undefined,
  opts: AuditOptions,
  config: Config,
  projectDir: string,
  invocationCwd: string,
  io: AuditIo = defaultIo,
): Promise<number> {
  const contentDir = resolveContentDir(config, projectDir);

  let target: string | undefined;
  if (path !== undefined) {
    const rel = toContentRelativeTarget(path, invocationCwd, contentDir);
    if (rel === null) {
      io.err(`Path is outside the content directory (${contentDir}): ${path}`);
      return 1;
    }
    target = rel === '' ? undefined : rel;
  }

  const lock = readServerLock(resolveLockDir(projectDir));
  if (!lock || lock.port <= 0) {
    io.err(SERVER_NOT_RUNNING_MESSAGE);
    return 1;
  }

  const query = target === undefined ? '' : `?path=${encodeURIComponent(target)}`;
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${lock.port}/api/audit${query}`, {
      headers: clientVersionHeaders({ kind: 'cli', runtimeVersion: RUNTIME_VERSION }),
    });
  } catch (e) {
    io.err(`Could not reach the OpenKnowledge server on port ${lock.port}: ${String(e)}`);
    return 1;
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      title?: string;
      error?: string;
      message?: string;
    };
    io.err(
      `Audit failed: ${body.title ?? body.error ?? body.message ?? `server responded with ${res.status}`}`,
    );
    return 1;
  }

  const parsed = ValidationAuditResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    const summary = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    io.err(`Audit failed: unexpected response shape from the server. Schema issues: ${summary}`);
    return 1;
  }
  const result = parsed.data;

  if (opts.json === true) {
    io.out(JSON.stringify(result, null, 2));
  } else {
    io.out(formatLintReport(toReportInput(result)));
  }

  const failed =
    opts.errorsOnly === true ? result.errorCount > 0 : result.errorCount + result.warningCount > 0;
  return failed ? 1 : 0;
}

export function toContentRelativeTarget(
  path: string,
  invocationCwd: string,
  contentDir: string,
): string | null {
  const rel = relative(contentDir, resolve(invocationCwd, path));
  if (rel === '') return '';
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

function toReportInput(result: ValidationAuditResponse): LintReportInput {
  return {
    files: result.files.map((f) => ({ file: f.file, fixed: false, diagnostics: f.diagnostics })),
    warnings: result.warnings,
    fileCount: result.fileCount,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    fixedCount: 0,
    ran: result.ran,
  };
}

/**
 * `ok audit [path]` — unified read-only validation audit: every content
 * problem (markdown-lint violations AND broken internal links) in one grouped
 * report. CLI sibling of the `audit` MCP tool and `GET /api/audit`.
 *
 * Server-first by necessity, not preference: the links validator reads the
 * running server's in-memory backlink index (there is no disk-only dead-link
 * oracle), so this command delegates to the project's live server instead of
 * walking files. No running server is an actionable error — `ok lint` remains
 * the headless, lint-only alternative.
 */

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

/**
 * Core audit flow, separated from the Commander wiring so tests can drive it
 * with a planted lock + stubbed `fetch` and injected writers.
 */
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

  // Same server-first discovery as `ok sync`: the lock anchor is the project
  // root, and `readServerLock` already prunes stale same-host locks.
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
    // RFC 9457 problem+json — `title` carries the user-visible message; fall
    // back through legacy shapes, then the HTTP status.
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
    // Name the offending fields: the headless CI consumer has no DevTools, so
    // a client/server version skew is otherwise indistinguishable from a
    // transient parse error. The Zod issues are pure structural metadata.
    const summary = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    io.err(`Audit failed: unexpected response shape from the server. Schema issues: ${summary}`);
    return 1;
  }
  const result = parsed.data;

  if (opts.json === true) {
    // Unlike the MCP tool (agent-context-bound, capped at 10×10), the CLI is
    // a terminal/CI surface — emit the full uncapped plane.
    io.out(JSON.stringify(result, null, 2));
  } else {
    io.out(formatLintReport(toReportInput(result)));
  }

  const failed =
    opts.errorsOnly === true ? result.errorCount > 0 : result.errorCount + result.warningCount > 0;
  return failed ? 1 : 0;
}

/**
 * Translate the user's path (relative to where they invoked the command) into
 * the contentDir-relative, forward-slash form `GET /api/audit?path=` expects.
 * Returns `''` for the content dir itself (audit everything) and `null` when
 * the path escapes the content dir.
 */
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

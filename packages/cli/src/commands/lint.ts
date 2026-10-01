import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  DEFAULT_LINTER_CONFIG,
  isAuditEmptyScopeWarning,
  type LinterConfig,
  type PersistedLinterConfig,
  type ProblemDetails,
  toEffectiveBase,
  validationCoverageLines,
} from '@inkeep/open-knowledge-core';
import {
  auditScopeNotFoundTitle,
  type Config,
  resolveAuditScope,
  resolveContentDir,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { type LintRunResult, runLint } from '../content/lint-runner.ts';
import { getInvocationCwd } from '../project-anchor.ts';
import { accent, dim, error as red, success, warning as yellow } from '../ui/colors.ts';

interface LintOptions {
  json?: boolean;
  fix?: boolean;
  errorsOnly?: boolean;
}

export function lintCommand(getConfig: () => Config): Command {
  return new Command('lint')
    .description('Lint markdown content (headless) — whole project, a folder, or a single file')
    .argument('[path]', 'Folder or file to lint, relative to where you run the command')
    .option('--json', 'Emit structured JSON instead of formatted text')
    .option('--fix', 'Auto-fix fixable issues in place (markdownlint rules only)')
    .option(
      '--errors-only',
      'Exit non-zero only on error-severity problems (findings are warning-severity unless your .markdownlint.* assigns a rule "error")',
    )
    .action(async (path: string | undefined, opts: LintOptions) => {
      const config = getConfig();
      const projectDir = process.cwd();
      const contentDir = resolveContentDir(config, projectDir);
      const targetPath = path === undefined ? undefined : resolveTarget(path, getInvocationCwd());
      const resolution = resolveAuditScope(targetPath, contentDir);
      if (!resolution.ok) {
        const problem: ProblemDetails = {
          type: 'urn:ok:error:not-found',
          title:
            path === undefined || resolution.path === contentDir
              ? resolution.title
              : auditScopeNotFoundTitle(path),
          status: 404,
          instance: `urn:uuid:${randomUUID()}`,
        };
        if (opts.json === true) process.stdout.write(`${JSON.stringify(problem, null, 2)}\n`);
        else process.stderr.write(`${problem.title}\n`);
        process.exitCode = 1;
        return;
      }
      const persistedLinter = config.contentRules as PersistedLinterConfig | undefined;
      const baseConfig: LinterConfig = persistedLinter
        ? toEffectiveBase(persistedLinter)
        : DEFAULT_LINTER_CONFIG;

      const result = await runLint({
        projectDir,
        contentDir,
        baseConfig,
        targetPath,
        resolvedScope: resolution.scope,
        fix: opts.fix === true,
      });

      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatLintReport(result)}\n`);
      }

      const failed = opts.errorsOnly === true ? result.errorCount > 0 : hasProblems(result);
      if (failed) process.exitCode = 1;
    });
}

export function resolveTarget(path: string, invocationCwd: string): string {
  return resolve(invocationCwd, path);
}

function hasProblems(result: LintRunResult): boolean {
  return result.errorCount > 0 || result.warningCount > 0;
}

interface ReportDiagnostic {
  range: { start: { line: number; character: number } };
  severity: string;
  source: string;
  code: string;
  message: string;
}

interface ReportFile {
  file: string;
  fixed: boolean;
  diagnostics: ReportDiagnostic[];
}

export interface LintReportInput {
  files: ReportFile[];
  warnings: string[];
  fileCount: number;
  errorCount: number;
  warningCount: number;
  fixedCount: number;
  ran?: string[];
}

function renderFileBlock(file: ReportFile): string[] {
  const lines: string[] = [accent(file.file) + (file.fixed ? dim(' (fixed)') : '')];
  for (const d of file.diagnostics) {
    const loc = dim(`${d.range.start.line + 1}:${d.range.start.character + 1}`.padEnd(7));
    const sev = d.severity === 'error' ? red('error  ') : yellow('warning');
    lines.push(`  ${loc} ${sev}  ${d.message}  ${dim(`${d.source}/${d.code}`)}`);
  }
  lines.push('');
  return lines;
}

export function formatLintReport(result: LintReportInput): string {
  const lines: string[] = [];
  for (const file of result.files) {
    if (file.diagnostics.length > 0) lines.push(...renderFileBlock(file));
  }

  const problemTotal = result.errorCount + result.warningCount;
  if (result.fileCount === 0) {
    lines.push(dim('No documents were checked.'));
  } else if (problemTotal === 0) {
    lines.push(
      success(`✓ No problems in ${result.fileCount} file${result.fileCount === 1 ? '' : 's'}.`),
    );
  } else {
    const parts = [`${problemTotal} problem${problemTotal === 1 ? '' : 's'}`];
    parts.push(`${result.errorCount} error${result.errorCount === 1 ? '' : 's'}`);
    parts.push(`${result.warningCount} warning${result.warningCount === 1 ? '' : 's'}`);
    lines.push(
      `${red(parts[0] ?? '')} (${parts[1]}, ${parts[2]}) across ${result.fileCount} file${result.fileCount === 1 ? '' : 's'}.`,
    );
  }
  if (result.fixedCount > 0) {
    lines.push(dim(`Fixed ${result.fixedCount} file${result.fixedCount === 1 ? '' : 's'}.`));
  }
  const coverage = validationCoverageLines(result.ran, result.fileCount);
  lines.push(...coverage.map((line) => dim(line)));
  if (result.warnings.length > 0) {
    lines.push('');
    for (const warning of result.warnings) {
      lines.push(isAuditEmptyScopeWarning(warning) ? dim(warning) : yellow(`! ${warning}`));
    }
  }

  return lines.join('\n');
}

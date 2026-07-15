/**
 * `ok lint [path]` — headless markdown linting over a project, a folder, or a
 * single file. Reuses the same engine as the source editor (project
 * `contentRules` base + native `.markdownlint.*` rules). Exits non-zero when
 * problems are found (CI-friendly), or only on errors with `--errors-only`.
 */

import { resolve } from 'node:path';
import {
  DEFAULT_LINTER_CONFIG,
  type LinterConfig,
  type PersistedLinterConfig,
  toEffectiveBase,
} from '@inkeep/open-knowledge-core';
import { type Config, resolveContentDir } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { type FileLintResult, type LintRunResult, runLint } from '../content/lint-runner.ts';
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
      // `lint` is a project-anchored command, so cwd is the project root; the
      // user's `[path]` is relative to where they actually invoked it.
      const targetPath = path === undefined ? undefined : resolveTarget(path, getInvocationCwd());
      // Persisted config omits markdownlint `rules` (native-file sourced); lift it
      // to an effective base, and runLint fills `rules` from the native file.
      const persistedLinter = config.contentRules as PersistedLinterConfig | undefined;
      const baseConfig: LinterConfig = persistedLinter
        ? toEffectiveBase(persistedLinter)
        : DEFAULT_LINTER_CONFIG;

      const result = await runLint({
        projectDir,
        contentDir,
        baseConfig,
        targetPath,
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

/** Render one file's heading + its diagnostics as report lines. */
function renderFileBlock(file: FileLintResult): string[] {
  const lines: string[] = [accent(file.file) + (file.fixed ? dim(' (fixed)') : '')];
  for (const d of file.diagnostics) {
    // Report locations are 1-based (editor convention); ranges are 0-based LSP.
    const loc = dim(`${d.range.start.line + 1}:${d.range.start.character + 1}`.padEnd(7));
    const sev = d.severity === 'error' ? red('error  ') : yellow('warning');
    lines.push(`  ${loc} ${sev}  ${d.message}  ${dim(`${d.source}/${d.code}`)}`);
  }
  lines.push('');
  return lines;
}

/** Render an eslint/markdownlint-style grouped report. */
export function formatLintReport(result: LintRunResult): string {
  const lines: string[] = [];
  for (const file of result.files) {
    if (file.diagnostics.length > 0) lines.push(...renderFileBlock(file));
  }

  for (const w of result.warnings) lines.push(yellow(`! ${w}`));
  if (result.warnings.length > 0) lines.push('');

  const problemTotal = result.errorCount + result.warningCount;
  if (problemTotal === 0) {
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

  return lines.join('\n');
}

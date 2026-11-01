import { relative } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { declaredSetupNonResultReasons, SETUP_NON_RESULT_ANNOTATION } from './setup-non-result.ts';

export const SETUP_NON_RESULT_REPORTER = fileURLToPath(import.meta.url);

interface DeclaredSetupNonResult {
  test: TestCase;
  retry: number;
  reasons: Array<string | undefined>;
  failed: boolean;
}

export default class SetupNonResultReporter implements Reporter {
  private rootDir = '';
  private readonly declared: DeclaredSetupNonResult[] = [];
  private failedResults = 0;
  private runErrors = 0;

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig): void {
    this.rootDir = config.rootDir;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const failed = result.status !== 'passed' && result.status !== 'skipped';
    if (failed) this.failedResults += 1;
    const reasons = declaredSetupNonResultReasons(result);
    if (reasons.length > 0) this.declared.push({ test, retry: result.retry, reasons, failed });
  }

  onError(): void {
    this.runErrors += 1;
  }

  onEnd(): void {
    if (this.declared.length === 0) return;
    const tag = `[${SETUP_NON_RESULT_ANNOTATION}]`;
    const declaredUnexpected = this.declared.filter(({ failed }) => failed);
    const lines = [
      `${tag} ${this.declared.length} result(s) in this run are declared setup non-results: the test body never ran because its setup did not complete, so they are not assertion failures. Only declared non-results are listed, so a result's absence from this block does not show that its test body ran. Each entry ends with its test's final outcome, which this declaration does not change.`,
      `${tag} summary ${JSON.stringify({
        declaredUnexpected: declaredUnexpected.length,
        unexpected: this.failedResults,
        runErrors: this.runErrors,
        reasons: declaredUnexpected.flatMap(({ reasons }) =>
          reasons.filter((reason): reason is string => reason !== undefined),
        ),
      })}`,
    ];
    for (const { test, retry, reasons } of this.declared) {
      const where = `${relative(this.rootDir, test.location.file)}:${test.location.line}:${test.location.column}`;
      lines.push(
        `${tag} ${where} › ${test.title}${retry > 0 ? ` (retry #${retry})` : ''}; test outcome: ${test.outcome()}`,
      );
      for (const reason of reasons) {
        if (reason === undefined) continue;
        for (const line of reason.split('\n')) lines.push(`${tag}     ${line}`);
      }
    }
    stdout.write(`\n${lines.join('\n')}\n`);
  }
}

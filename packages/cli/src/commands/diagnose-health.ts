/**
 * `ok diagnose health` — runs every environment check (git, Bun, config,
 * content dir, server lock, shadow repo, macOS code-sig) and emits a
 * structured report. Sibling of `ok diagnose process <pid>`; shares the
 * parent `diagnose` command-group.
 *
 * Flags:
 *   --json              NDJSON output (one CheckResult per line)
 *   --verbose           include detail field + probe-context in human output
 *   --check <name>      run only the named check (single name; multi-check
 *                       via comma-list is intentionally not supported — keep
 *                       the contract simple and shell-loop friendly)
 *   --quiet             suppress output; exit code only
 *
 * Exit codes:
 *   0 = all pass (warn does NOT fail)
 *   1 = any fail
 *   2 = usage error (unknown check name)
 *
 * Each check runs through `runCheck` (timeout + try/catch). The runner never
 * short-circuits — every selected check runs, so the user sees a complete
 * report even when an earlier check fails.
 */

import { Command } from 'commander';
import pc from 'picocolors';
import {
  CHECK_NAMES,
  type CheckDefinition,
  type CheckName,
  type CheckResult,
  isCheckName,
  makeBunCheck,
  makeConfigYamlCheck,
  makeContentDirCheck,
  makeGitCheck,
  makeMacosCodesigCheck,
  makeServerLockCheck,
  makeShadowHealthCheck,
  makeShadowRepoCheck,
  runAllChecks,
} from './diagnose-health-checks/index.ts';

export interface RunHealthChecksOpts {
  cwd: string;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  check?: string;
}

export interface RunHealthChecksDeps {
  checks?: readonly CheckDefinition[];
  /** Injectable for tests. */
  stdout?: (line: string) => void;
  /** Injectable for tests. */
  stderr?: (line: string) => void;
  /** Override per-check timeout (testing only). */
  timeoutMs?: number;
}

/** Build the default check registry. Order matches the human-readable output. */
export function defaultChecks(): CheckDefinition[] {
  return [
    makeGitCheck(),
    makeBunCheck(),
    makeConfigYamlCheck(),
    makeContentDirCheck(),
    makeServerLockCheck(),
    makeShadowRepoCheck(),
    makeShadowHealthCheck(),
    makeMacosCodesigCheck(),
  ];
}

function statusGlyph(status: CheckResult['status']): string {
  switch (status) {
    case 'pass':
      return pc.green('✓');
    case 'warn':
      return pc.yellow('!');
    case 'fail':
      return pc.red('✗');
  }
}

function formatHuman(result: CheckResult, verbose: boolean): string[] {
  const lines = [`[${statusGlyph(result.status)}] ${result.name}: ${result.summary}`];
  if (result.remediation !== undefined && result.status !== 'pass') {
    lines.push(`    → ${result.remediation}`);
  }
  if (verbose && result.detail !== undefined) {
    for (const line of result.detail.split('\n')) {
      lines.push(`    ${pc.dim(line)}`);
    }
  }
  return lines;
}

function summarize(results: readonly CheckResult[]): string {
  const errors = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;
  if (errors === 0 && warnings === 0) return 'All checks passed';
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * Run the health checks and return the process exit code (0/1/2). Returns
 * rather than calling `process.exit` directly — easier to test, easier to
 * compose.
 */
export async function runHealthChecks(
  opts: RunHealthChecksOpts,
  deps: RunHealthChecksDeps = {},
): Promise<number> {
  const checks = deps.checks ?? defaultChecks();
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const quiet = opts.quiet ?? false;
  const json = opts.json ?? false;
  const verbose = opts.verbose ?? false;

  let selected: CheckDefinition[];
  if (opts.check !== undefined) {
    if (!isCheckName(opts.check)) {
      stderr(pc.red(`unknown check '${opts.check}'. Valid: ${CHECK_NAMES.join(', ')}`));
      return 2;
    }
    const target: CheckName = opts.check;
    const found = checks.find((c) => c.name === target);
    if (!found) {
      stderr(pc.red(`internal error: check '${opts.check}' not registered`));
      return 2;
    }
    selected = [found];
  } else {
    selected = [...checks];
  }

  const ctx = { cwd: opts.cwd };
  const results = await runAllChecks(
    selected,
    ctx,
    deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {},
  );

  if (!quiet) {
    if (json) {
      for (const result of results) {
        stdout(JSON.stringify(result));
      }
    } else {
      for (const result of results) {
        for (const line of formatHuman(result, verbose)) {
          stdout(line);
        }
      }
      stdout('');
      stdout(summarize(results));
    }
  }

  const anyFail = results.some((r) => r.status === 'fail');
  return anyFail ? 1 : 0;
}

/** Build the `health` subcommand and attach it to the parent `diagnose` root. */
export function healthCommand(): Command {
  return new Command('health')
    .description(`Run environment health checks (${CHECK_NAMES.join(', ')})`)
    .option('--json', 'Emit NDJSON (one CheckResult per line)')
    .option('--verbose', 'Include detail field + probe context in human-readable output')
    .option('--check <name>', `Run only the named check. One of: ${CHECK_NAMES.join(', ')}`)
    .option('--quiet', 'Suppress output; exit code only')
    .action(
      async (opts: { json?: boolean; verbose?: boolean; check?: string; quiet?: boolean }) => {
        const exitCode = await runHealthChecks({
          cwd: process.cwd(),
          json: opts.json,
          verbose: opts.verbose,
          check: opts.check,
          quiet: opts.quiet,
        });
        process.exit(exitCode);
      },
    );
}

/**
 * Shared types for the `ok diagnose health` per-check modules.
 *
 * Each check is an async function that returns a `CheckResult`. The runner
 * applies a per-check timeout and a try/catch boundary, so check
 * implementations don't have to defend against either themselves.
 */

import type { CheckName } from './names.ts';

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface CheckResult {
  /** Stable kebab-case identifier (e.g. `git`, `config-yaml`). */
  name: CheckName;
  status: CheckStatus;
  /** One-line outcome shown in human-readable output. */
  summary: string;
  /** Optional user-facing fix-it hint. Shown after the summary on `fail`/`warn`. */
  remediation?: string;
  /** Optional verbose payload; surfaces only with `--verbose` and in `--json`. */
  detail?: string;
}

/** Context threaded into every check; injectable for tests. */
export interface CheckContext {
  /** Absolute project root the user invoked `ok diagnose health` from. */
  cwd: string;
}

export type CheckFn = (ctx: CheckContext) => Promise<CheckResult>;

export interface CheckDefinition {
  name: CheckName;
  run: CheckFn;
}

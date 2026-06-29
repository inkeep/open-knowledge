import type { CheckName } from './names.ts';

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface CheckResult {
  name: CheckName;
  status: CheckStatus;
  summary: string;
  remediation?: string;
  detail?: string;
}

export interface CheckContext {
  cwd: string;
}

export type CheckFn = (ctx: CheckContext) => Promise<CheckResult>;

export interface CheckDefinition {
  name: CheckName;
  run: CheckFn;
}

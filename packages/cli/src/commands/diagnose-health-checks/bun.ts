import { spawnSync } from 'node:child_process';
import type { CheckDefinition, CheckResult } from './types.ts';

interface BunCheckDeps {
  probe?: () => { ok: boolean; version?: string; error?: string };
}

const PROBE_TIMEOUT_MS = 5000;

function defaultProbe(): { ok: boolean; version?: string; error?: string } {
  const result = spawnSync('bun', ['--version'], {
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.signal === 'SIGTERM') {
    return { ok: false, error: 'probe timed out' };
  }
  if (result.status !== 0) {
    return { ok: false, error: result.stderr?.trim() || `exit code ${result.status}` };
  }
  return { ok: true, version: result.stdout.trim() };
}

export function makeBunCheck(deps: BunCheckDeps = {}): CheckDefinition {
  const probe = deps.probe ?? defaultProbe;
  return {
    name: 'bun',
    run: async (): Promise<CheckResult> => {
      const result = probe();
      if (!result.ok) {
        return {
          name: 'bun',
          status: 'fail',
          summary: 'bun not found on PATH',
          remediation: 'Install Bun: https://bun.sh/docs/installation',
          detail: result.error,
        };
      }
      return {
        name: 'bun',
        status: 'pass',
        summary: `bun ${result.version}`,
      };
    },
  };
}

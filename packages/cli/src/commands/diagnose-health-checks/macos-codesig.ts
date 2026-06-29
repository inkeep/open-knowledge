
import { spawnSync } from 'node:child_process';
import type { CheckDefinition, CheckResult } from './types.ts';

interface MacosCodesigCheckDeps {
  platform?: NodeJS.Platform;
  execPath?: string;
  codesignVerify?: (bundlePath: string) => { ok: boolean; stderr: string };
}

const PROBE_TIMEOUT_MS = 5000;
const TRANSLOCATED_PREFIX = '/private/var/folders/';

function defaultCodesignVerify(bundlePath: string): { ok: boolean; stderr: string } {
  const r = spawnSync('codesign', ['--verify', '--deep', '--strict', bundlePath], {
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
  if (r.error) return { ok: false, stderr: r.error.message };
  if (r.signal === 'SIGTERM') return { ok: false, stderr: 'codesign probe timed out' };
  return { ok: r.status === 0, stderr: (r.stderr ?? '').trim() };
}

export function makeMacosCodesigCheck(deps: MacosCodesigCheckDeps = {}): CheckDefinition {
  const platform = deps.platform ?? process.platform;
  const execPath = deps.execPath ?? process.execPath;
  const codesignVerify = deps.codesignVerify ?? defaultCodesignVerify;
  return {
    name: 'macos-codesig',
    run: async (): Promise<CheckResult> => {
      if (platform !== 'darwin') {
        return {
          name: 'macos-codesig',
          status: 'pass',
          summary: `skipped on ${platform} (macOS-only check)`,
        };
      }
      const marker = '/Contents/MacOS/';
      const idx = execPath.indexOf(marker);
      if (idx === -1) {
        return {
          name: 'macos-codesig',
          status: 'pass',
          summary: 'dev mode (no app bundle)',
        };
      }
      const bundlePath = execPath.slice(0, idx);
      if (bundlePath.startsWith(TRANSLOCATED_PREFIX)) {
        return {
          name: 'macos-codesig',
          status: 'fail',
          summary: 'app is running translocated (quarantine sandbox)',
          remediation: 'Drag OpenKnowledge.app to /Applications/ and re-launch.',
          detail: `bundlePath: ${bundlePath}`,
        };
      }
      const verify = codesignVerify(bundlePath);
      if (!verify.ok) {
        return {
          name: 'macos-codesig',
          status: 'fail',
          summary: 'codesign --verify failed',
          remediation: 'Re-download OpenKnowledge from the official releases page.',
          detail: `bundlePath: ${bundlePath}\n${verify.stderr}`,
        };
      }
      return {
        name: 'macos-codesig',
        status: 'pass',
        summary: `signed bundle at ${bundlePath}`,
      };
    },
  };
}

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JSONReport, JSONReportSpec, JSONReportSuite } from '@playwright/test/reporter';
import { APP_PACKAGE_ROOT } from '../server-process.ts';

const PLAYWRIGHT_CLI = createRequire(join(APP_PACKAGE_ROOT, 'package.json')).resolve(
  '@playwright/test/cli',
);

export interface NestedPlaywrightRun {
  readonly exitCode: number | null;
  readonly transcript: string;
  readonly report: JSONReport | undefined;
}

export function specsOf(suites: readonly JSONReportSuite[]): JSONReportSpec[] {
  return suites.flatMap((suite) => [...suite.specs, ...specsOf(suite.suites ?? [])]);
}

export async function runNestedPlaywright({
  args,
  runDirPrefix,
  env,
}: {
  readonly args: readonly string[];
  readonly runDirPrefix: string;
  readonly env: (runDir: string) => NodeJS.ProcessEnv;
}): Promise<NestedPlaywrightRun> {
  const runDir = mkdtempSync(join(tmpdir(), runDirPrefix));
  try {
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', ...args], {
      cwd: APP_PACKAGE_ROOT,
      env: env(runDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let transcript = '';
    child.stdout.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      transcript += chunk.toString('utf8');
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    const reportPath = join(runDir, 'results.json');
    const report = existsSync(reportPath)
      ? (JSON.parse(readFileSync(reportPath, 'utf8')) as JSONReport)
      : undefined;
    return { exitCode, transcript, report };
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

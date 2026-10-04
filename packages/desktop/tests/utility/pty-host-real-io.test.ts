import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isTerminalPlatform } from '../../src/shared/terminal-platform.ts';
import { harnessTimeouts, runHarness } from '../support/pty-readiness.test-helper.ts';
import { harnessScenarioTitles } from '../support/real-io-harness-roster.test-helper.ts';
import { removeTempDirBestEffort } from '../support/temp-dir-cleanup.test-helper.ts';
import { runWindowsOsStateProof } from '../support/windows-os-state-proof.test-helper.ts';

const HARNESS_TIMEOUTS = harnessTimeouts(process.platform);

const TERMINAL_PLATFORM = isTerminalPlatform(process.platform);
const SCENARIO_COUNT = harnessScenarioTitles(process.platform).length;
const SUCCESS_RESULT = `HARNESS_RESULT ok=${SCENARIO_COUNT} fail=0 refused=0`;

describe('PTY host — real shell I/O (Node runtime)', () => {
  test.skipIf(!TERMINAL_PLATFORM)(
    'real interactive shell round-trips commands, strips env markers, survives a kill, and reports a bad shell',
    async () => {
      const outputDir = mkdtempSync(join(tmpdir(), 'ok-real-pty-wrapper-'));
      try {
        const output = await runHarness(outputDir);
        for (const line of output
          .split(/\r?\n/u)
          .filter((l) => l.startsWith('INPUT_READY ') || l.startsWith('PTY_HOST '))) {
          console.log(line);
        }
        expect(output).toContain(SUCCESS_RESULT);
      } finally {
        removeTempDirBestEffort(outputDir);
      }
    },
    HARNESS_TIMEOUTS.testTimeoutMs,
  );

  test.skipIf(!TERMINAL_PLATFORM)(
    'refuses every scenario a spent budget cannot cover, rather than running into the hard timeout',
    async () => {
      const outputDir = mkdtempSync(join(tmpdir(), 'ok-real-pty-budget-'));
      try {
        const failure = await runHarness(outputDir, { OK_PTY_HARNESS_BUDGET_MS: '1' }).then(
          () => null,
          (error: unknown) => (error as Error).message,
        );
        expect(failure).toContain('the 1ms harness budget was spent before this scenario started');
        expect(failure).toContain(`HARNESS_RESULT ok=0 fail=0 refused=${SCENARIO_COUNT}`);
        expect(failure).not.toContain('hard timeout');
        if (process.platform === 'win32') await runWindowsOsStateProof();
      } finally {
        removeTempDirBestEffort(outputDir);
      }
    },
    HARNESS_TIMEOUTS.testTimeoutMs,
  );
});

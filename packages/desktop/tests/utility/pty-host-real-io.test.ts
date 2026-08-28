import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { isTerminalPlatform } from '../../src/shared/terminal-platform.ts';
import { removeTempDirBestEffort } from '../support/temp-dir-cleanup.test-helper.ts';

/**
 * Gate wrapper for the real-shell-I/O seam. The actual PTY drive runs in an
 * isolated Node subprocess so native handles cannot leak into the Vitest worker.
 */

const HARNESS = fileURLToPath(new URL('./pty-host.real-io-harness.ts', import.meta.url));

const TERMINAL_PLATFORM = isTerminalPlatform(process.platform);
const SUCCESS_RESULT = `HARNESS_RESULT ok=${process.platform === 'win32' ? 5 : 4} fail=0`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runHarness(outputDir: string): Promise<string> {
  const outputPath = join(outputDir, 'output.log');
  const outputFd = openSync(outputPath, 'w');
  const child = (() => {
    try {
      // A descendant can inherit a captured pipe on Windows and keep the
      // parent waiting for EOF after the harness itself has settled.
      return spawn(process.execPath, [HARNESS], {
        env: {
          ...process.env,
          TEMP: outputDir,
          TMP: outputDir,
          TMPDIR: outputDir,
        },
        stdio: ['ignore', outputFd, outputFd],
        windowsHide: true,
      });
    } finally {
      closeSync(outputFd);
    }
  })();

  let spawnError: Error | null = null;
  let exitResult: { code: number | null; signal: string | null } | null = null;
  let resolveExit: () => void = () => undefined;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  child.once('error', (error) => {
    spawnError = error;
  });
  child.once('exit', (code, signal) => {
    exitResult = { code, signal };
    resolveExit();
  });

  async function terminateChild(): Promise<void> {
    if (exitResult === null) {
      child.kill();
      await Promise.race([exitPromise, sleep(2_000)]);
    }
    child.unref();
  }

  try {
    const deadline = Date.now() + (process.platform === 'win32' ? 90_000 : 45_000);
    while (Date.now() < deadline) {
      const output = readFileSync(outputPath, 'utf8');
      if (spawnError !== null) {
        throw new Error(`real-PTY harness could not start: ${spawnError.message}\n${output}`);
      }

      const completeLines = output.split(/\r?\n/u);
      completeLines.pop();
      const resultLine = completeLines.find((line) => line.startsWith('HARNESS_RESULT '));
      if (resultLine !== undefined) {
        if (resultLine !== SUCCESS_RESULT) {
          throw new Error(`real-PTY harness reported failure:\n${output}`);
        }
        if (exitResult !== null && exitResult.code !== 0) {
          throw new Error(
            `real-PTY harness exited ${exitResult.code ?? exitResult.signal} after success:\n${output}`,
          );
        }
        return output;
      }

      if (exitResult !== null) {
        throw new Error(
          `real-PTY harness exited ${exitResult.code ?? exitResult.signal} without a verdict:\n${output}`,
        );
      }
      await sleep(25);
    }

    const output = readFileSync(outputPath, 'utf8');
    throw new Error(`real-PTY harness timed out without a verdict:\n${output}`);
  } finally {
    await terminateChild();
  }
}

describe('PTY host — real shell I/O (Node runtime)', () => {
  test.skipIf(!TERMINAL_PLATFORM)(
    'real interactive shell round-trips commands, strips env markers, survives a kill, and reports a bad shell',
    async () => {
      const outputDir = mkdtempSync(join(tmpdir(), 'ok-real-pty-wrapper-'));
      try {
        const output = await runHarness(outputDir);
        expect(output).toContain(SUCCESS_RESULT);
      } finally {
        removeTempDirBestEffort(outputDir);
      }
    },
    process.platform === 'win32' ? 105_000 : 60_000,
  );
});

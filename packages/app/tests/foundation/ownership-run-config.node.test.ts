import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { runOwnershipCase } from '../stress/_helpers/port-ownership/run-case.test-helper.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('nested ownership Playwright config', () => {
  it.each([
    { caller: 'lifetime-normal', exitCode: 0 },
    { caller: 'lifetime-timeout', exitCode: 1 },
  ])(
    'publishes and releases $caller resources while Git is pending',
    async ({ caller, exitCode }) => {
      const scratch = mkdtempSync(join(tmpdir(), 'ok-ownership-git-'));
      onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
      const preload = join(scratch, 'pending-git.cjs');
      const event = join(scratch, 'event.json');
      writeFileSync(
        preload,
        `
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const spawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  if (command === 'git') {
    process.stderr.write('OWNED_GIT_PENDING ' + args[0] + '\\n');
    return spawn.call(this, process.execPath, ['-e', 'process.stdin.resume()'], options);
  }
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();
process.stderr.write('OWNED_GIT_PRELOAD_READY\\n');
`,
      );
      writeFileSync(
        event,
        JSON.stringify({
          pull_request: {
            number: 1,
            title: 'lifetime',
            base: { sha: '1111111111111111111111111111111111111111' },
          },
        }),
      );
      vi.stubEnv('GITHUB_ACTIONS', 'true');
      vi.stubEnv('GITHUB_EVENT_PATH', event);
      vi.stubEnv('NODE_OPTIONS', `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim());
      const { run, scratchReleased } = await runOwnershipCase({
        file: 'tests/stress/_helpers/port-ownership/lifetime.ownership-case.ts',
        name: 'nested lifetime control reaches its test body',
        caller,
      });
      const cleanupError = await scratchReleased;

      expect(run.transcript).toContain('OWNED_GIT_PRELOAD_READY');
      expect(run.lifetime?.receipt, run.transcript).toBeDefined();
      expect(run.lifetime?.selfBoundFired, run.transcript).toBe(false);
      expect(run.exitCode, run.transcript).toBe(exitCode);
      expect(run.stdioClosed, run.transcript).toBe(true);
      expect(run.lifetime?.servingAfterExit, run.transcript).toBe(false);
      expect(cleanupError).toBeUndefined();
      expect(run.transcript).not.toContain('OWNED_GIT_PENDING');
    },
  );
});

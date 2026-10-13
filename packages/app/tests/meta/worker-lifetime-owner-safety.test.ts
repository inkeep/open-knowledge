import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  HELPERS_DIR,
  launchRecorded,
  makeRunDir,
  readCleanup,
  waitUntil,
  writeOwnerConfig,
} from '../foundation/worker-lifetime/owner-launch.test-helper.ts';

const readySchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
});

describe('worker lifetime observation owner safety', () => {
  for (const ending of ['normal release', 'outer owner killed'] as const) {
    it(`${ending}: both owned listeners and descendants are reclaimed`, async () => {
      const run = makeRunDir(ending.replaceAll(' ', '-'));
      const path = writeOwnerConfig({
        ...run,
        cwd: HELPERS_DIR,
        args: [join(HELPERS_DIR, 'safety-subject.cjs')],
        environment: { OK_LIFETIME_SAFETY_DIR: run.dir },
        deadlineMs: 30_000,
      });
      const guardian =
        process.env.OK_LIFETIME_SAFETY_GUARDIAN ?? join(HELPERS_DIR, 'resource-owner.cjs');
      const { child, exited } = launchRecorded(
        join(HELPERS_DIR, 'safety-outer-owner.cjs'),
        [path, guardian],
        run.dir,
        run.runId,
      );
      try {
        await waitUntil(
          () =>
            ['parent', 'child'].every((role) => existsSync(join(run.dir, `safety-${role}.json`))),
          10_000,
        );
        const ready = ['parent', 'child'].map((role) =>
          readySchema.parse(JSON.parse(readFileSync(join(run.dir, `safety-${role}.json`), 'utf8'))),
        );
        const before = await Promise.all(
          ready.map(
            async ({ port }) =>
              (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1_000) }))
                .status,
          ),
        );
        expect(before).toEqual([200, 200]);
        const endedAt = Date.now();
        if (ending === 'normal release') child.send({ type: 'release', runId: run.runId });
        else child.kill('SIGKILL');
        await expect
          .poll(() => existsSync(join(run.dir, 'cleanup.json')), { timeout: 8_000 })
          .toBe(true);
        const cleanup = readCleanup(run.dir);
        expect(cleanup.reason).toBe(
          ending === 'normal release'
            ? 'normal release after observation'
            : 'outer owner disconnected',
        );
        expect(cleanup.before.filter((row) => row.birth.found).map((row) => row.birth.pid)).toEqual(
          expect.arrayContaining(ready.map((item) => item.pid)),
        );
        expect(cleanup.liveSurvivors).toEqual([]);
        expect(cleanup.workDirAbsent).toBe(true);
        const after = await Promise.all(
          ready.map(async ({ port }) =>
            fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1_000) }).then(
              (response) => response.status,
              () => null,
            ),
          ),
        );
        expect(after).toEqual([null, null]);
        writeFileSync(
          join(run.dir, 'safety-verdict.json'),
          `${JSON.stringify({ ending, ready, before, after, cleanupElapsedMs: cleanup.at - endedAt, cleanupReason: cleanup.reason }, null, 2)}\n`,
        );
      } finally {
        if (child.connected) child.send({ type: 'release', runId: run.runId }, () => {});
        await exited;
        await waitUntil(() => existsSync(join(run.dir, 'cleanup.json')), 35_000);
      }
    }, 50_000);
  }
});

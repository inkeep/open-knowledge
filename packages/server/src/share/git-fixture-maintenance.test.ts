import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createGitTriangle } from '../../tests/support/git-fixture.test-helper.ts';

const traceEventSchema = z.object({
  event: z.string(),
  argv: z.array(z.string()).optional(),
});

test.each(['sender', 'receiver', 'origin'] as const)(
  '%s fixture finishes Git operations without automatic maintenance',
  (kind) => {
    const triangle = createGitTriangle();
    const traceDir = mkdtempSync(join(tmpdir(), 'ok-git-fixture-trace-'));
    try {
      const repository =
        kind === 'sender'
          ? triangle.senderDir
          : kind === 'origin'
            ? triangle.originDir
            : triangle.cloneReceiver();
      triangle.git(repository, ['config', 'maintenance.strategy', 'incremental']);
      triangle.git(repository, ['config', 'maintenance.loose-objects.auto', '-1']);
      const tracePath = join(traceDir, 'events.jsonl');
      const args =
        kind === 'origin'
          ? ['fetch', '--quiet', triangle.senderDir, triangle.branch]
          : ['commit', '--quiet', '--allow-empty', '-m', 'fixture operation'];
      const operation = spawnSync('git', args, {
        cwd: repository,
        env: { ...process.env, GIT_TRACE2_EVENT: tracePath },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      });

      expect(operation.error).toBeUndefined();
      expect(operation.status, operation.stderr).toBe(0);
      const events = readFileSync(tracePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => traceEventSchema.parse(JSON.parse(line)));
      expect(events.some((event) => event.event === 'version')).toBe(true);
      expect(
        events
          .filter((event) => event.event === 'child_start' && event.argv?.[1] === 'maintenance')
          .map((event) => event.argv),
      ).toEqual([]);
    } finally {
      triangle.cleanup();
      rmSync(traceDir, { recursive: true, force: true });
    }
  },
);

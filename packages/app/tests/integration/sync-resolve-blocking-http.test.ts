/**
 * HTTP contract for `POST /api/sync/resolve-blocking` — the button behind
 * "Changed here and on the remote", which commits exactly the tracked files
 * whose local edits overlap an incoming merge and then resumes sync.
 *
 * The handler has four distinct response paths and the schema deliberately
 * admits only one action. Each is covered here because this is the one route
 * in the sync surface that writes a git commit on the user's behalf: a wrong
 * 200 commits files the user did not choose, and a wrong 409 leaves them stuck
 * behind a pause with no in-app way out.
 */

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createSyncWiredTestServer, type SyncWiredTestServer } from './test-harness';

const execFileAsync = promisify(execFile);

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: dir });
  return stdout.trim();
}

interface ErrorBody {
  type?: string;
  title?: string;
}

describe('POST /api/sync/resolve-blocking', () => {
  const servers: SyncWiredTestServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.cleanup().catch(() => {});
    }
  });

  async function post(port: number): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/sync/resolve-blocking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'commit' }),
    });
  }

  test(
    'refuses with 409 when nothing is blocking a merge',
    async () => {
      // The pause is what authorizes the commit. Without one there is no
      // engine-owned path set, and committing whatever happens to be dirty
      // would sweep up unrelated work the user never saw named in the panel.
      const server = await createSyncWiredTestServer({ mode: 'full' });
      servers.push(server);

      const res = await post(server.port);

      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrorBody;
      expect(body.type).toBe('urn:ok:error:no-blocking-changes');
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'commits exactly the blocking paths and reports them back',
    async () => {
      // The pause fires on the CLASSIC pull path (verb `sync`), for tracked
      // files OUTSIDE the content scope that the incoming merge also touches.
      // Content-scoped markdown never reaches it: that path commits dirty
      // docs itself, and the explicit-Pull verb routes to B1, which records a
      // ledger conflict instead. `data.json` is the shape that actually blocks.
      const server = await createSyncWiredTestServer({
        mode: 'full',
        originSeed: {
          '.claude/settings.json': '{"v":1}\n',
          'notes.md': '# Notes\n\nbase\n',
        },
      });
      servers.push(server);
      const { sync } = server;
      const contentDir = server.contentDir;

      // A teammate changes the same non-content file...
      await sync.pushToOrigin({ '.claude/settings.json': '{"v":2}\n' }, 'remote bump');
      // ...while this machine has an uncommitted local edit to it, plus an
      // unrelated dirty non-content file the merge does NOT touch, which must
      // stay out of the commit.
      writeFileSync(join(contentDir, '.claude/settings.json'), '{"v":"local"}\n', 'utf-8');
      writeFileSync(join(contentDir, 'notes.md'), '# Notes\n\nlocal\n', 'utf-8');

      await sync.engine.trigger('sync');

      const blocking = sync.engine.getBlockingPaths();
      expect(blocking).toEqual(['.claude/settings.json']);
      expect(sync.engine.getStatus().pausedReason).toBe('external-changes-pending');

      const res = await post(server.port);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        action: string;
        paths: string[];
        commitSha?: string;
      };
      expect(body.action).toBe('commit');
      expect(body.paths).toEqual(['.claude/settings.json']);

      // The commit landed and touched only the blocking file.
      const committed = await git(contentDir, ['show', '--name-only', '--format=', 'HEAD']);
      expect(committed.split('\n').filter(Boolean)).toEqual(['.claude/settings.json']);
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'rejects an unknown action before reaching the engine',
    async () => {
      // `discard` was deliberately not shipped — reverting uncommitted work is
      // unrecoverable. The schema is what keeps a future client (or a typo)
      // from reaching a branch that does not exist.
      const server = await createSyncWiredTestServer({ mode: 'full' });
      servers.push(server);

      const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-blocking`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'discard' }),
      });

      expect(res.status).toBe(400);
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'rejects a non-POST method',
    async () => {
      const server = await createSyncWiredTestServer({ mode: 'full' });
      servers.push(server);

      const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-blocking`);

      expect(res.status).toBe(405);
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );
});

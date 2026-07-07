/**
 * `open-knowledge sync` — commit + pull + push.
 *
 * Server-first: discovers a running Hocuspocus server via server.lock and
 * delegates to POST /api/sync/trigger { op: 'sync' }. Falls back to a
 * one-shot simple-git workflow when no live server is found.
 */
import { clientVersionHeaders } from '@inkeep/open-knowledge-core';
import {
  type Config,
  RUNTIME_VERSION,
  readServerLock,
  resolveLockDir,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import simpleGit from 'simple-git';

function emit(json: boolean, obj: Record<string, unknown>): void {
  if (json) process.stdout.write(`${JSON.stringify(obj)}\n`);
}

interface SyncOptions {
  json: boolean;
  op?: 'sync' | 'push' | 'pull';
}

/**
 * Core sync logic — tries the live server first, falls back to simple-git.
 */
export async function runSync(
  opts: SyncOptions,
  _config: Config,
  cwd = process.cwd(),
): Promise<void> {
  const op = opts.op ?? 'sync';
  // Lock anchor is the project root (cwd), not contentDir — see
  // server-factory.ts. simple-git fallback uses cwd directly as baseDir.
  const lockDir = resolveLockDir(cwd);

  // Server-first: delegate to running server if available.
  const lock = readServerLock(lockDir);
  if (lock && lock.port > 0) {
    const url = `http://127.0.0.1:${lock.port}/api/sync/trigger`;
    if (!opts.json) {
      process.stderr.write(`Triggering ${op} via running server (port ${lock.port})\n`);
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...clientVersionHeaders({ kind: 'cli', runtimeVersion: RUNTIME_VERSION }),
        },
        body: JSON.stringify({ op }),
      });
      if (!res.ok) {
        // RFC 9457 problem+json — read `title` for the user-visible
        // message; fall back through legacy `error`/`message` for forward-
        // compat with older servers, then HTTP status as a last resort.
        const body = (await res.json().catch(() => ({}))) as {
          title?: string;
          error?: string;
          message?: string;
        };
        throw new Error(
          body.title ?? body.error ?? body.message ?? `Server responded with ${res.status}`,
        );
      }
      emit(opts.json, { type: 'triggered', op, port: lock.port });
      if (!opts.json) {
        process.stderr.write(`✓ ${op} triggered\n`);
      }
      return;
    } catch (err) {
      // Fall through to simple-git on network error
      const msg = err instanceof Error ? err.message : String(err);
      if (!opts.json) {
        process.stderr.write(`Server trigger failed (${msg}), running directly\n`);
      }
    }
  }

  // Fallback: one-shot simple-git
  if (!opts.json) {
    process.stderr.write(`Running ${op} directly (no live server)\n`);
  }

  const git = simpleGit({ baseDir: cwd });

  if (op === 'sync' || op === 'pull') {
    emit(opts.json, { type: 'step', step: 'pull' });
    const result = await git.pull();
    emit(opts.json, { type: 'pull', summary: result.summary });
    if (!opts.json) {
      process.stderr.write(`  pull: ${result.summary.changes} changes\n`);
    }
  }

  if (op === 'sync' || op === 'push') {
    emit(opts.json, { type: 'step', step: 'push' });
    await git.push();
    emit(opts.json, { type: 'push', ok: true });
    if (!opts.json) {
      process.stderr.write('  push: ok\n');
    }
  }

  emit(opts.json, { type: 'complete', op });
  if (!opts.json) {
    process.stderr.write(`✓ ${op} complete\n`);
  }
}

export function syncCommand(getConfig: () => Config): Command {
  return new Command('sync')
    .description('Commit, pull, and push to the remote')
    .option('--json', 'Output JSONL progress events', false)
    .action(async (opts: { json: boolean }) => {
      try {
        await runSync({ json: opts.json, op: 'sync' }, getConfig());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ type: 'error', message: msg })}\n`);
        } else {
          process.stderr.write(`✗ sync failed: ${msg}\n`);
        }
        process.exit(1);
      }
    });
}

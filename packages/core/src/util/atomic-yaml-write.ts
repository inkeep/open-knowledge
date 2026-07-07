/**
 * Atomic write helpers (async + sync siblings) for config / state files.
 *
 * Used by `packages/core/src/config/` (config.yml), `packages/core/src/
 * skill-state/` (skill-state.yml), and `packages/cli/src/commands/init.ts`
 * (Claude Desktop / Cursor / Codex / VS Code / Windsurf MCP host configs).
 *
 * Atomic guarantees: tmp + rename. `rename(2)` is atomic on the same
 * filesystem, so external readers never observe a torn file. On rename
 * failure, best-effort tmp cleanup — never throws on cleanup. The
 * caller's error is what matters.
 *
 * Sync/async sibling pattern matches `withFileLock` / `withFileLockSync`
 * in `./file-lock.ts`. Prefer `atomicWriteFile` (async) when the caller
 * can `await`; use `atomicWriteFileSync` only when forced sync (the
 * `writeEditorMcpConfig` call graph in `init.ts` is the canonical
 * example).
 *
 * `fs-traced.ts` lives in `packages/server/` (Bun OTel workaround for
 * oven-sh/bun#6546) and core cannot depend on server. Async callers
 * that want traced disk spans pass an `fs` adapter wired to the traced
 * primitives; the sync variant does not accept an adapter (no traced
 * sync primitives exist yet).
 */

import { readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  readdir as nodeReaddir,
  rename as nodeRename,
  stat as nodeStat,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Crash-orphan tmp files are siblings of the target that were created
 * by a prior atomic-write call which was killed (SIGKILL, OOM, power
 * loss) between writeFile and rename. They never get cleaned by the
 * normal try/catch path because the process didn't survive to run it.
 *
 * Threshold is set well above any realistic in-flight atomic-write
 * duration (writeFile + rename are microseconds even on slow disks).
 * A concurrent writer's same-target tmp will always be younger than
 * the threshold and so safely skipped by the sweep.
 */
const STALE_TMP_AGE_MS = 30_000;

export interface AtomicWriteFsAdapter {
  writeFile(
    path: string,
    content: string,
    opts: { encoding: 'utf-8'; mode?: number },
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const DEFAULT_FS: AtomicWriteFsAdapter = {
  writeFile: (path, content, opts) => nodeWriteFile(path, content, opts),
  rename: (from, to) => nodeRename(from, to),
};

export interface AtomicWriteOptions {
  /** Posix file mode for the final file. Defaults to 0o644 (config is not secret). */
  mode?: number;
  /**
   * Inject traced fs primitives. Server-side callers pass `{writeFile: tracedWriteFile, rename: tracedRename}`
   * from `packages/server/src/fs-traced.ts` so disk writes appear as `fs.*` spans.
   */
  fs?: AtomicWriteFsAdapter;
}

export interface AtomicWriteSyncOptions {
  /** Posix file mode for the final file. Defaults to 0o644 (config is not secret). */
  mode?: number;
}

/**
 * Best-effort sweep of crash-orphan `${basename}.tmp.*` siblings older
 * than `STALE_TMP_AGE_MS`. Runs at the start of every atomic-write call
 * so accumulation in long-lived directories (`~/.cursor/`, `~/.codex/`,
 * `~/.claude/`, Claude Desktop's Application Support dir) self-corrects
 * over time. Never throws — if any fs op fails the sweep silently
 * yields to the actual write.
 */
async function sweepStaleTmps(absPath: string): Promise<void> {
  try {
    const parent = dirname(absPath);
    const prefix = `${basename(absPath)}.tmp.`;
    const cutoff = Date.now() - STALE_TMP_AGE_MS;
    const entries = await nodeReaddir(parent);
    await Promise.all(
      entries.map(async (name) => {
        if (!name.startsWith(prefix)) return;
        const full = join(parent, name);
        try {
          const st = await nodeStat(full);
          if (st.mtimeMs < cutoff) await nodeUnlink(full);
        } catch {
          /* best-effort */
        }
      }),
    );
  } catch {
    /* best-effort sweep; never blocks the write */
  }
}

function sweepStaleTmpsSync(absPath: string): void {
  try {
    const parent = dirname(absPath);
    const prefix = `${basename(absPath)}.tmp.`;
    const cutoff = Date.now() - STALE_TMP_AGE_MS;
    for (const name of readdirSync(parent)) {
      if (!name.startsWith(prefix)) continue;
      const full = join(parent, name);
      try {
        const st = statSync(full);
        if (st.mtimeMs < cutoff) unlinkSync(full);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort sweep; never blocks the write */
  }
}

/**
 * Write `content` atomically to `absPath` via tmp + rename. Tmp filename is
 * `${absPath}.tmp.${randomUUID}`. Caller is responsible for ensuring the
 * parent directory exists.
 */
export async function atomicWriteFile(
  absPath: string,
  content: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  await sweepStaleTmps(absPath);
  const fs = opts.fs ?? DEFAULT_FS;
  const tmpPath = `${absPath}.tmp.${crypto.randomUUID()}`;
  try {
    await fs.writeFile(tmpPath, content, { encoding: 'utf-8', mode: opts.mode ?? 0o644 });
    await fs.rename(tmpPath, absPath);
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup; the original error is what matters */
    }
    throw e;
  }
}

/**
 * Synchronous sibling of `atomicWriteFile`. Same atomicity contract and
 * tmp-cleanup-on-failure semantics; uses `node:fs` sync primitives
 * directly (no fs adapter — traced sync primitives don't exist yet).
 * Caller is responsible for ensuring the parent directory exists.
 *
 * Use only when the call graph is forced sync. Prefer the async variant
 * whenever the caller can `await`.
 */
export function atomicWriteFileSync(
  absPath: string,
  content: string,
  opts: AtomicWriteSyncOptions = {},
): void {
  sweepStaleTmpsSync(absPath);
  const tmpPath = `${absPath}.tmp.${crypto.randomUUID()}`;
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: opts.mode ?? 0o644 });
    renameSync(tmpPath, absPath);
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup; the original error is what matters */
    }
    throw e;
  }
}

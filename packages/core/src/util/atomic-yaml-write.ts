import { readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  readdir as nodeReaddir,
  rename as nodeRename,
  stat as nodeStat,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ATOMIC_TEMP_INFIX, atomicTempPath } from './atomic-temp-path.ts';

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
  mode?: number;
  sweepStaleTmps?: boolean;
  fs?: AtomicWriteFsAdapter;
}

export interface AtomicWriteSyncOptions {
  mode?: number;
}

async function sweepStaleTmps(absPath: string): Promise<void> {
  try {
    const parent = dirname(absPath);
    const prefix = `${basename(absPath)}${ATOMIC_TEMP_INFIX}`;
    const cutoff = Date.now() - STALE_TMP_AGE_MS;
    const entries = await nodeReaddir(parent);
    await Promise.all(
      entries.map(async (name) => {
        if (!name.startsWith(prefix)) return;
        const full = join(parent, name);
        try {
          const st = await nodeStat(full);
          if (st.mtimeMs < cutoff) await nodeUnlink(full);
        } catch {}
      }),
    );
  } catch {}
}

function sweepStaleTmpsSync(absPath: string): void {
  try {
    const parent = dirname(absPath);
    const prefix = `${basename(absPath)}${ATOMIC_TEMP_INFIX}`;
    const cutoff = Date.now() - STALE_TMP_AGE_MS;
    for (const name of readdirSync(parent)) {
      if (!name.startsWith(prefix)) continue;
      const full = join(parent, name);
      try {
        const st = statSync(full);
        if (st.mtimeMs < cutoff) unlinkSync(full);
      } catch {}
    }
  } catch {}
}

export async function atomicWriteFile(
  absPath: string,
  content: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  if (opts.sweepStaleTmps !== false) await sweepStaleTmps(absPath);
  const fs = opts.fs ?? DEFAULT_FS;
  const tmpPath = atomicTempPath(absPath);
  try {
    await fs.writeFile(tmpPath, content, { encoding: 'utf-8', mode: opts.mode ?? 0o644 });
    await fs.rename(tmpPath, absPath);
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw e;
  }
}

export function atomicWriteFileSync(
  absPath: string,
  content: string,
  opts: AtomicWriteSyncOptions = {},
): void {
  sweepStaleTmpsSync(absPath);
  const tmpPath = atomicTempPath(absPath);
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: opts.mode ?? 0o644 });
    renameSync(tmpPath, absPath);
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw e;
  }
}

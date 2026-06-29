
import { readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  readdir as nodeReaddir,
  rename as nodeRename,
  stat as nodeStat,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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
  fs?: AtomicWriteFsAdapter;
}

export interface AtomicWriteSyncOptions {
  mode?: number;
}

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
        }
      }),
    );
  } catch {
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
      }
    }
  } catch {
  }
}

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
    }
    throw e;
  }
}

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
    }
    throw e;
  }
}

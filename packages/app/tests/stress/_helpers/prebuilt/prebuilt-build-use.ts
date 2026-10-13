import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type PrebuiltBuildUse = { readonly release: () => void };

const USE_LOCKS_DIR = '.uses';
const ROOT_USE_LOCK = 'root';
const DISCARD_WAIT_MS = 60_000;
const SQLITE_BUSY = 5;

function openUseLock(outRoot: string, digest: string, waitMs: number): DatabaseSync {
  const dir = join(outRoot, USE_LOCKS_DIR);
  mkdirSync(dir, { recursive: true });
  return new DatabaseSync(join(dir, `${digest}.sqlite`), { timeout: waitMs });
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown }).errcode;
  return typeof code === 'number' && (code & 0xff) === SQLITE_BUSY;
}

function holdReadUse(outRoot: string, name: string): DatabaseSync {
  const lock = openUseLock(outRoot, name, DISCARD_WAIT_MS);
  try {
    lock.exec('BEGIN');
    lock.prepare('SELECT count(*) FROM sqlite_schema').get();
    return lock;
  } catch (error) {
    lock.close();
    throw error;
  }
}

export function holdPrebuiltBuildUse(outRoot: string, digest: string): PrebuiltBuildUse {
  const root = holdReadUse(outRoot, ROOT_USE_LOCK);
  try {
    const lock = holdReadUse(outRoot, digest);
    return {
      release: () => {
        try {
          if (lock.isOpen) lock.close();
        } finally {
          if (root.isOpen) root.close();
        }
      },
    };
  } catch (error) {
    root.close();
    throw error;
  }
}

export function withPrebuiltBuildMutation(
  outRoot: string,
  digest: string,
  mutate: () => 'landed' | 'joined',
): 'landed' | 'joined' {
  const lock = openUseLock(outRoot, `${digest}.mutation`, DISCARD_WAIT_MS);
  try {
    lock.exec('BEGIN EXCLUSIVE');
    return mutate();
  } finally {
    lock.close();
  }
}

export function resetPrebuiltOutput(outRoot: string): boolean {
  const lock = openUseLock(outRoot, ROOT_USE_LOCK, 0);
  try {
    try {
      lock.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      if (isBusy(error)) return false;
      throw error;
    }
    for (const name of readdirSync(outRoot)) {
      if (name !== USE_LOCKS_DIR) rmSync(join(outRoot, name), { recursive: true, force: true });
    }
    return readdirSync(outRoot).every((name) => name === USE_LOCKS_DIR);
  } finally {
    lock.close();
  }
}

export function discardUnlessInUse(outRoot: string, digest: string, discard: () => void): boolean {
  const lock = openUseLock(outRoot, digest, 0);
  try {
    try {
      lock.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      if (isBusy(error)) return false;
      throw error;
    }
    discard();
    return true;
  } finally {
    lock.close();
  }
}

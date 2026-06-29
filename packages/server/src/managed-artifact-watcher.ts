import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { tracedMkdirSync } from './fs-traced.ts';
import { getLogger } from './logger.ts';

export type ManagedArtifactWatcherUnsubscribe = () => Promise<void>;

export interface ManagedArtifactWatchOptions {
  depth: number;
  acceptLeaf: (absPath: string) => boolean;
}

const SKILL_WATCH_OPTIONS: ManagedArtifactWatchOptions = {
  depth: 1,
  acceptLeaf: (p) => basename(p) === 'SKILL.md',
};

export const TEMPLATE_WATCH_OPTIONS: ManagedArtifactWatchOptions = {
  depth: 0,
  acceptLeaf: (p) => basename(p).endsWith('.md'),
};

export async function startManagedArtifactWatcher(
  roots: ReadonlyArray<string>,
  onChange: (absPath: string, content: string) => void,
  opts: ManagedArtifactWatchOptions = SKILL_WATCH_OPTIONS,
): Promise<ManagedArtifactWatcherUnsubscribe> {
  const log = getLogger('managed-artifact-watcher');
  const { watch } = await import('chokidar');

  const watchRoots = Array.from(new Set(roots));
  for (const dir of watchRoots) {
    try {
      tracedMkdirSync(dir, { recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        log.warn({ err, dir }, 'failed to create watch root; watcher may be inert');
      }
    }
  }

  const watcher = watch(watchRoots, {
    ignoreInitial: true,
    depth: opts.depth,
    usePolling: true,
    interval: 200,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  await new Promise<void>((resolve) => {
    watcher.once('ready', resolve);
  });

  const lastContent = new Map<string, string | null>();

  const handlePath = (path: string): void => {
    if (!opts.acceptLeaf(path)) return;
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        log.debug({ path }, 'managed-artifact leaf disappeared between event and read; dropping');
        return;
      }
      log.warn({ err, path }, 'managed-artifact leaf read failed; dropping event');
      return;
    }
    if (content === lastContent.get(path)) return;
    lastContent.set(path, content);
    try {
      onChange(path, content);
    } catch (err) {
      log.warn({ err, path }, 'managed-artifact change handler threw');
    }
  };
  const handler = (path: string): void => handlePath(path);

  watcher.on('add', handler);
  watcher.on('change', handler);
  watcher.on('unlink', (path) => {
    if (!opts.acceptLeaf(path)) return;
    lastContent.delete(path);
    log.debug({ path }, 'managed-artifact leaf unlinked; live doc retained at current state');
  });
  watcher.on('error', (err) => {
    log.warn({ err, watchRoots }, '[managed-artifact-watcher] chokidar error');
  });

  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await watcher.close();
  };
}

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { tracedMkdirSync } from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';

export type ManagedArtifactWatcherUnsubscribe = () => Promise<void>;

const isSkillLeaf = (absPath: string): boolean => basename(absPath) === 'SKILL.md';

export async function startManagedArtifactWatcher(
  roots: ReadonlyArray<string>,
  onChange: (absPath: string, content: string) => void,
  onUnlink?: (absPath: string) => void,
): Promise<ManagedArtifactWatcherUnsubscribe> {
  const log = getLogger('managed-artifact-watcher');
  const { watch } = await import('chokidar');

  const watchRoots = Array.from(new Set(roots));
  for (const dir of watchRoots) {
    try {
      tracedMkdirSync(dir, { recursive: true });
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'EEXIST') {
        log.warn({ err, dir }, 'failed to create watch root; watcher may be inert');
      }
    }
  }

  const watcher = watch(watchRoots, {
    ignoreInitial: true,
    depth: 1,
    usePolling: true,
    interval: 200,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  await new Promise<void>((resolve) => {
    watcher.once('ready', resolve);
  });

  const lastContent = new Map<string, string | null>();

  const handlePath = (path: string): void => {
    if (!isSkillLeaf(path)) return;
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      const code = errnoCode(err);
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
    if (!isSkillLeaf(path)) return;
    lastContent.delete(path);
    log.debug({ path }, 'managed-artifact leaf unlinked; live doc retained at current state');
    if (onUnlink) {
      try {
        onUnlink(path);
      } catch (err) {
        log.warn({ err, path }, 'managed-artifact unlink handler threw');
      }
    }
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

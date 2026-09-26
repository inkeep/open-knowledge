import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tracedMkdirSync } from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';
import { startPolledPathWatcher } from './polled-path-watcher.ts';

export type ManagedArtifactWatcherUnsubscribe = () => Promise<void>;

export async function startManagedArtifactWatcher(
  roots: ReadonlyArray<string>,
  onChange: (absPath: string, content: string) => void,
  onUnlink?: (absPath: string) => void,
): Promise<ManagedArtifactWatcherUnsubscribe> {
  const log = getLogger('managed-artifact-watcher');

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

  const lastContent = new Map<string, string | null>();

  const handlePath = (path: string): void => {
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
  const handleUnlink = (path: string): void => {
    lastContent.delete(path);
    log.debug({ path }, 'managed-artifact leaf unlinked; live doc retained at current state');
    if (onUnlink) {
      try {
        onUnlink(path);
      } catch (err) {
        log.warn({ err, path }, 'managed-artifact unlink handler threw');
      }
    }
  };

  const listedLeaves = new Map<string, ReadonlyArray<string>>();
  const failingRoots = new Map<string, string | undefined>();
  const listLeaves = async (root: string): Promise<ReadonlyArray<string>> => {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT') {
        failingRoots.delete(root);
        listedLeaves.set(root, []);
        return [];
      }
      if (!failingRoots.has(root) || failingRoots.get(root) !== code) {
        failingRoots.set(root, code);
        log.warn({ err, root }, 'failed to list watch root; keeping its previous listing');
      }
      return listedLeaves.get(root) ?? [];
    }
    failingRoots.delete(root);
    const leaves = [
      join(root, 'SKILL.md'),
      ...entries.map((entry) => join(root, entry, 'SKILL.md')),
    ];
    listedLeaves.set(root, leaves);
    return leaves;
  };

  return startPolledPathWatcher({
    listPaths: async () => (await Promise.all(watchRoots.map(listLeaves))).flat(),
    onEvent: (event, path) => (event === 'unlink' ? handleUnlink(path) : handlePath(path)),
    onError: (err, path) => {
      log.warn({ err, path }, '[managed-artifact-watcher] poll error');
    },
  });
}

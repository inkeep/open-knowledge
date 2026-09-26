import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tracedMkdirSync } from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';
import { startPolledPathWatcher } from './polled-path-watcher.ts';

export type ConfigFileWatcherUnsubscribe = () => Promise<void>;

export async function startConfigFileWatcher(
  absPath: string,
  onChange: (content: string) => void,
): Promise<ConfigFileWatcherUnsubscribe> {
  const log = getLogger('config-file-watcher');

  const watchDir = dirname(absPath);
  try {
    tracedMkdirSync(watchDir, { recursive: true });
  } catch (err) {
    const code = errnoCode(err);
    if (code !== 'EEXIST') {
      log.warn({ err, watchDir }, 'failed to create watch directory; watcher may be inert');
    }
  }

  let lastContent: string | null = null;
  try {
    lastContent = readFileSync(absPath, 'utf-8');
  } catch {}
  const handlePath = (path: string, logMissing = true): void => {
    if (path !== absPath) return;
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT') {
        if (logMissing) {
          log.debug({ path }, 'config file disappeared between event and read; dropping');
        }
        return;
      }
      log.warn({ err, path }, 'config file read failed; dropping event');
      return;
    }
    if (content === lastContent) return;
    lastContent = content;
    try {
      onChange(content);
    } catch (err) {
      log.warn({ err, path }, 'config file change handler threw');
    }
  };
  const handleUnlink = (path: string): void => {
    if (path !== absPath) return;
    log.debug({ path }, 'config file unlinked; Y.Text retained at current state');
  };

  const stop = await startPolledPathWatcher({
    listPaths: async () => [absPath],
    onEvent: (event, path) => (event === 'unlink' ? handleUnlink(path) : handlePath(path)),
    onError: (err, path) => {
      log.warn({ err, path }, '[config-file-watcher] poll error');
    },
  });
  handlePath(absPath, false);
  return stop;
}

export async function startMultiPathConfigFileWatcher(
  absPaths: ReadonlyArray<string>,
  onChange: (path: string, content: string) => void,
): Promise<ConfigFileWatcherUnsubscribe> {
  if (absPaths.length === 0) {
    throw new Error('startMultiPathConfigFileWatcher requires at least one absolute path');
  }
  const log = getLogger('config-file-watcher');

  const watchedPaths = new Set(absPaths);
  const watchDirs = Array.from(new Set(Array.from(watchedPaths, (p) => dirname(p))));

  for (const dir of watchDirs) {
    try {
      tracedMkdirSync(dir, { recursive: true });
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'EEXIST') {
        log.warn({ err, dir }, 'failed to create watch directory; watcher may be inert');
      }
    }
  }

  const lastContent = new Map<string, string | null>();
  for (const path of watchedPaths) {
    try {
      lastContent.set(path, readFileSync(path, 'utf-8'));
    } catch {
      lastContent.set(path, null);
    }
  }

  const handlePath = (path: string, logMissing = true): void => {
    if (!watchedPaths.has(path)) return;
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT') {
        if (logMissing) {
          log.debug({ path }, 'config file disappeared between event and read; dropping');
        }
        return;
      }
      log.warn({ err, path }, 'config file read failed; dropping event');
      return;
    }
    if (content === lastContent.get(path)) return;
    lastContent.set(path, content);
    try {
      onChange(path, content);
    } catch (err) {
      log.warn({ err, path }, 'config file change handler threw');
    }
  };
  const handleUnlink = (path: string): void => {
    if (!watchedPaths.has(path)) return;
    log.debug({ path }, 'config file unlinked; downstream state retained');
  };

  const stop = await startPolledPathWatcher({
    listPaths: async () => Array.from(watchedPaths),
    onEvent: (event, path) => (event === 'unlink' ? handleUnlink(path) : handlePath(path)),
    onError: (err, path) => {
      log.warn({ err, path }, '[config-file-watcher] poll error');
    },
  });
  for (const path of watchedPaths) handlePath(path, false);
  return stop;
}

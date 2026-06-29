
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tracedMkdirSync } from './fs-traced.ts';
import { getLogger } from './logger.ts';

export type ConfigFileWatcherUnsubscribe = () => Promise<void>;

export async function startConfigFileWatcher(
  absPath: string,
  onChange: (content: string) => void,
): Promise<ConfigFileWatcherUnsubscribe> {
  const log = getLogger('config-file-watcher');
  const { watch } = await import('chokidar');

  const watchDir = dirname(absPath);
  try {
    tracedMkdirSync(watchDir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      log.warn({ err, watchDir }, 'failed to create watch directory; watcher may be inert');
    }
  }

  const watcher = watch(watchDir, {
    ignoreInitial: true,
    depth: 0, // only direct children — sibling subdirectories irrelevant
    usePolling: true,
    interval: 200,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignored: (p) => p !== watchDir && p !== absPath,
  });

  await new Promise<void>((resolve) => {
    watcher.once('ready', resolve);
  });

  let lastContent: string | null = null;
  try {
    lastContent = readFileSync(absPath, 'utf-8');
  } catch {
  }
  const handlePath = (path: string, logMissing = true): void => {
    if (path !== absPath) return;
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        if (logMissing)
          log.debug({ path }, 'config file disappeared between event and read; dropping');
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
  const handler = (path: string): void => handlePath(path);

  watcher.on('add', handler);
  watcher.on('change', handler);
  watcher.on('unlink', (path) => {
    if (path !== absPath) return;
    log.debug({ path }, 'config file unlinked; Y.Text retained at current state');
  });
  watcher.on('error', (err) => {
    log.warn(
      { err, watchDir, absPath },
      `[config-file-watcher] chokidar error while watching ${absPath}`,
    );
  });
  let fallbackAttempts = 0;
  const fallbackPoll = setInterval(() => {
    fallbackAttempts++;
    handlePath(absPath, false);
    if (fallbackAttempts >= 20) clearInterval(fallbackPoll);
  }, 500);
  fallbackPoll.unref?.();

  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    clearInterval(fallbackPoll);
    await watcher.close();
  };
}

export async function startMultiPathConfigFileWatcher(
  absPaths: ReadonlyArray<string>,
  onChange: (path: string, content: string) => void,
): Promise<ConfigFileWatcherUnsubscribe> {
  if (absPaths.length === 0) {
    throw new Error('startMultiPathConfigFileWatcher requires at least one absolute path');
  }
  const log = getLogger('config-file-watcher');
  const { watch } = await import('chokidar');

  const watchedPaths = new Set(absPaths);
  const watchDirs = Array.from(new Set(Array.from(watchedPaths, (p) => dirname(p))));

  for (const dir of watchDirs) {
    try {
      tracedMkdirSync(dir, { recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        log.warn({ err, dir }, 'failed to create watch directory; watcher may be inert');
      }
    }
  }

  const watcher = watch(watchDirs, {
    ignoreInitial: true,
    depth: 0,
    usePolling: true,
    interval: 200,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignored: (p) => !watchedPaths.has(p) && !watchDirs.includes(p),
  });

  await new Promise<void>((resolve) => {
    watcher.once('ready', resolve);
  });

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
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        if (logMissing)
          log.debug({ path }, 'config file disappeared between event and read; dropping');
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
  const handler = (path: string): void => handlePath(path);

  watcher.on('add', handler);
  watcher.on('change', handler);
  watcher.on('unlink', (path) => {
    if (!watchedPaths.has(path)) return;
    log.debug({ path }, 'config file unlinked; downstream state retained');
  });
  watcher.on('error', (err) => {
    log.warn(
      { err, watchDirs, paths: Array.from(watchedPaths) },
      '[config-file-watcher] chokidar error in multi-path watcher',
    );
  });

  let fallbackAttempts = 0;
  const fallbackPoll = setInterval(() => {
    fallbackAttempts++;
    for (const path of watchedPaths) {
      handlePath(path, false);
    }
    if (fallbackAttempts >= 20) clearInterval(fallbackPoll);
  }, 500);
  fallbackPoll.unref?.();

  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    clearInterval(fallbackPoll);
    await watcher.close();
  };
}

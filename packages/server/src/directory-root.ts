import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';

const log = getLogger('directory-root');

export function resolveNativePath(path: string): string {
  return realpathSync.native(path);
}

export function resolveExistingNativeAncestor(path: string): {
  ancestor: string;
  missingSegments: string[];
} {
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return { ancestor: resolveNativePath(cursor), missingSegments };
    } catch (error) {
      const code = errnoCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export function resolveDirectoryRoot(
  directory: string,
  site: {
    root: 'content' | 'project';
    component:
      | 'persistence'
      | 'local-target-index'
      | 'asset-walk'
      | 'file-watcher'
      | 'server-factory';
  },
): string {
  try {
    return resolveNativePath(directory);
  } catch (err) {
    const code = errnoCode(err);
    const fields = { path: directory, root: site.root, component: site.component, code };
    if (code === 'ENOENT') log.debug(fields, 'directory root left unresolved');
    else log.warn(fields, 'directory root left unresolved');
    return directory;
  }
}

import { realpathSync } from 'node:fs';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';

const log = getLogger('directory-root');

export function resolveNativePath(path: string): string {
  return realpathSync.native(path);
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

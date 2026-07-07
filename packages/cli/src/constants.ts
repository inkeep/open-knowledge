import pkgJson from '../package.json' with { type: 'json' };

/** Root directory name for open-knowledge inside a project. */
export { OK_DIR } from '@inkeep/open-knowledge-core';

/** Workspace-level config file inside the open-knowledge directory. */
export const CONFIG_FILENAME = 'config.yml';

export const PACKAGE_VERSION = pkgJson.version;

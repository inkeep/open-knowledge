/**
 * Path resolution helpers shared across CLI commands.
 *
 * `resolveContentDir` is the single choke point for deriving `<contentDir>`
 * from a cwd + config (used for content walks + asset serve, NOT for lock
 * resolution). The lock anchor is the project root (cwd) — see `resolveLockDir`.
 */

import { resolve } from 'node:path';
import { getLocalDir } from '@inkeep/open-knowledge-server';
import type { Config } from './schema.ts';

/**
 * Resolve the absolute content directory from a config and cwd.
 * Equivalent to `resolve(cwd, config.content.dir)`; centralized so the
 * content walk + asset serve always resolve the same way.
 */
export function resolveContentDir(config: Config, cwd: string): string {
  return resolve(cwd, config.content.dir);
}

/**
 * The `.ok/local/` directory at a project root — where the server lock,
 * registry entries, and other per-machine runtime state files live.
 *
 * Pass the project root (cwd for the CLI), NOT contentDir. The server
 * anchors `.ok/local/` at projectDir so one repo presents one `.ok/`
 * regardless of `content.dir`; CLI lock-readers must match that anchor
 * or they look in the wrong tree when `content.dir != '.'`.
 */
export function resolveLockDir(projectDir: string): string {
  return getLocalDir(projectDir);
}

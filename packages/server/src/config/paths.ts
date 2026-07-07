/**
 * Path resolution helpers shared across CLI commands.
 *
 * `resolveContentDir` is the single choke point for deriving `<contentDir>`
 * from a cwd + config. `start` and `mcp` both call it so MCP port discovery
 * cannot silently look in the wrong place.
 */

import { resolve } from 'node:path';
import { LOCAL_DIR, OK_DIR } from '@inkeep/open-knowledge-core';
import type { Config } from './schema.ts';

/**
 * Resolve the absolute content directory from a config and cwd.
 * Equivalent to `resolve(cwd, config.content.dir)`; centralized so MCP
 * and the server cannot disagree about where the server.lock lives.
 */
export function resolveContentDir(config: Config, cwd: string): string {
  return resolve(cwd, config.content.dir);
}

/**
 * Absolute path to a project's per-machine runtime-state directory:
 * `<projectDir>/.ok/local/`.
 *
 * Anchor is the project root (`projectDir`), NOT `contentDir` — the server
 * writes `<projectDir>/.ok/local/server.lock` regardless of whether
 * `content.dir` is `.` or a sub-folder (the git-root-promotion case where
 * one repo presents one `.ok/`). CLI commands that read the lock
 * (`ok stop`, `ok status`, `ok mcp`, `ok ui`, `ok clean`, `ok sync`) and
 * MCP tool handlers must call `getLocalDir(projectDir)` — anchoring on
 * contentDir would look in the wrong tree when `content.dir != '.'`.
 *
 * Single resolution helper for every server-side site that builds
 * `resolve(projectDir, '.ok')` inline. Routes for `server.lock`, `ui.lock`,
 * `state.json`, `principal.json`, `sync-state.json`, `conflicts.json`,
 * `last-spawn-error.log`, `cache/<branch>/...`, and `tmp/upload-<uuid>` all
 * resolve under here.
 *
 * Lives in `@inkeep/open-knowledge-server` (Node-only) — not in `-core` —
 * because it imports `node:path`. Frontend bundles (Vite) externalize
 * `node:path` and the destructured import would crash at module load even
 * if no caller invoked the function. Frontend code that needs to format a
 * runtime path for display imports the bare `LOCAL_DIR` constant from
 * `-core` and concatenates as a string.
 */
export function getLocalDir(projectDir: string): string {
  return resolve(projectDir, OK_DIR, LOCAL_DIR);
}

/**
 * The `.ok/local/` directory inside a projectDir — where the server lock,
 * registry entries, and other per-machine runtime state files live.
 *
 * Alias for `getLocalDir`; preserved for callers that name their parameter
 * `lockDir` rather than `localDir`. Pass the project root, NOT contentDir
 * — see `getLocalDir`.
 */
export function resolveLockDir(projectDir: string): string {
  return getLocalDir(projectDir);
}

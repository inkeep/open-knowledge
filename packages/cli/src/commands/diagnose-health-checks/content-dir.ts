/**
 * `content-dir` check — resolves `content.dir` from the project config and
 * verifies the directory exists AND is writable (sentinel write probe).
 *
 * Skipped (status='warn') when the project isn't initialized — same posture
 * as the `config-yaml` check.
 */

import { accessSync, existsSync, constants as fsConstants, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../../config/loader.ts';
import { CONFIG_FILENAME, OK_DIR } from '../../constants.ts';
import type { CheckContext, CheckDefinition, CheckResult } from './types.ts';

interface ContentDirCheckDeps {
  loader?: (cwd: string) => { config: { content: { dir: string } } };
  /** Replaceable so tests can simulate read-only mounts. */
  probeWritable?: (dir: string) => { writable: boolean; reason?: string };
}

function defaultProbeWritable(dir: string): { writable: boolean; reason?: string } {
  // Stat-only check (no file create/delete cycle). The previous
  // `mkdtempSync` + `rmSync` implementation generated filesystem events on
  // watched / synced filesystems (Dropbox, iCloud Drive, fswatch consumers,
  // editors using inotify); `accessSync(W_OK)` answers the same question
  // (kernel-level permission check vs. effective uid/gid + ACLs) without
  // touching disk content.
  try {
    accessSync(dir, fsConstants.W_OK);
    return { writable: true };
  } catch (err) {
    return { writable: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function makeContentDirCheck(deps: ContentDirCheckDeps = {}): CheckDefinition {
  const load = deps.loader ?? loadConfig;
  const probeWritable = deps.probeWritable ?? defaultProbeWritable;
  return {
    name: 'content-dir',
    run: async (ctx: CheckContext): Promise<CheckResult> => {
      const configPath = resolve(ctx.cwd, OK_DIR, CONFIG_FILENAME);
      if (!existsSync(configPath)) {
        return {
          name: 'content-dir',
          status: 'warn',
          summary: 'project not initialized',
          remediation: `Run \`ok init\` to scaffold the project.`,
        };
      }
      let contentDir: string;
      try {
        const { config } = load(ctx.cwd);
        contentDir = resolve(ctx.cwd, config.content.dir);
      } catch (err) {
        return {
          name: 'content-dir',
          status: 'fail',
          summary: 'content.dir unresolved (config invalid)',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      if (!existsSync(contentDir)) {
        return {
          name: 'content-dir',
          status: 'fail',
          summary: `content.dir does not exist: ${contentDir}`,
          remediation: `Create the directory or fix \`content.dir\` in ${OK_DIR}/${CONFIG_FILENAME}.`,
        };
      }
      const st = statSync(contentDir);
      if (!st.isDirectory()) {
        return {
          name: 'content-dir',
          status: 'fail',
          summary: `content.dir is not a directory: ${contentDir}`,
        };
      }
      const writable = probeWritable(contentDir);
      if (!writable.writable) {
        return {
          name: 'content-dir',
          status: 'fail',
          summary: `content.dir is not writable: ${contentDir}`,
          detail: writable.reason,
        };
      }
      return {
        name: 'content-dir',
        status: 'pass',
        summary: `${contentDir} (writable)`,
      };
    },
  };
}

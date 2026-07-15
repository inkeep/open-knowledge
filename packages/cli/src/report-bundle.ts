/**
 * Leveled bug-report capture — the one entry shared by the `ok bug-report`
 * CLI command and the desktop report-a-bug flow, so the two stay in lockstep.
 * `standard` wraps the bug-report capture; `full` wraps the diagnose bundle
 * collector (`diagnose/bundle.ts`) two-step contract.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  ReportBundleLevel as CoreReportBundleLevel,
  ReportBundleSummary as CoreReportBundleSummary,
} from '@inkeep/open-knowledge-core';
import { parse as parseYaml } from 'yaml';
import {
  type BundleExtraFile,
  type BundleLogger,
  collectStandardBundle,
  resolveProjectSlug,
} from './commands/bug-report-bundle.ts';
import {
  collectBundle,
  type DesktopMetadata,
  defaultReadDesktopEnv,
  writeBundle,
} from './diagnose/bundle.ts';
import { isObject } from './utils/is-object.ts';

// The level + summary types live in core so the desktop bridge contract's
// per-package copies (core / desktop / app renderer) can all name the same
// types; aliased here (not `export ... from` — that re-export form trips a
// rolldown-plugin-dts chunk bug) so this module stays the CLI's one public
// entry for the leveled capture.
export type ReportBundleLevel = CoreReportBundleLevel;
export type ReportBundleSummary = CoreReportBundleSummary;

export interface CollectReportBundleOptions {
  level: ReportBundleLevel;
  /**
   * Project root (where `.ok/` lives). Omit for a system-wide bundle:
   * user-level logs + sysinfo only.
   */
  projectDir?: string;
  /** Free-text user note included as `note.txt`. */
  note?: string;
  /** Apply redaction (secret-pattern scrub at both levels; doc-name anonymization at `full`). */
  redact: boolean;
  /** Zip destination; parent directories are created as needed. */
  outputPath: string;
  /** Files included byte-for-byte under `extra/` (e.g. an opted-in minidump) — never scrubbed. */
  extraFiles?: BundleExtraFile[];
  /** Override the user-level logs directory (standard-level test seam). */
  userLogsDir?: string;
  /**
   * Collection-progress + warning sink. The full level reports its inventory
   * via the manifest and uses this only for warnings (e.g. an opted-in extra
   * file that could not be staged).
   */
  logger?: BundleLogger;
  /**
   * Host (desktop) metadata source for the bundle's runtime/sysinfo blocks.
   * Defaults to reading the `OK_DESKTOP_*` env block, so CLI invocations are
   * unchanged; the desktop app injects its typed metadata here directly
   * instead of mutating `process.env` (which would leak into any child later
   * spawned with the main process's env). Returning `null` means "not an
   * Electron host" and is recorded as such at both levels.
   */
  readDesktopEnv?: () => DesktopMetadata | null;
}

export interface ReportBundleResult {
  zipPath: string;
  summary: ReportBundleSummary;
}

/**
 * Read `content.dir` from the project config, falling back to the project
 * root. Deliberately fail-open (no throw on a missing/corrupt config): a
 * broken config may be the very problem being reported, and the capture must
 * still succeed.
 */
function resolveContentDir(projectDir: string, logger?: BundleLogger): string {
  const configPath = join(projectDir, '.ok', 'config.yml');
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = parseYaml(readFileSync(configPath, 'utf-8'));
      const content = isObject(parsed) ? parsed.content : undefined;
      const dir = isObject(content) ? content.dir : undefined;
      if (typeof dir === 'string' && dir.length > 0) {
        return resolve(projectDir, dir);
      }
    } catch (err) {
      // A malformed or unreadable .ok/config.yml falls back to the project
      // root (the bundle should still succeed), but log it so a wrong
      // content-dir in the resulting bundle is diagnosable, not silent.
      logger?.warn(
        { configPath, err: err instanceof Error ? err.message : String(err) },
        'bug-report: failed to read .ok/config.yml; falling back to project root as content dir',
      );
    }
  }
  return resolve(projectDir);
}

async function collectFullBundle(
  opts: CollectReportBundleOptions,
  projectDir: string,
  readDesktopEnv: () => DesktopMetadata | null,
): Promise<ReportBundleResult> {
  const collected = await collectBundle({
    contentDir: resolveContentDir(projectDir, opts.logger),
    projectDir,
    redact: opts.redact,
    scrubSecrets: opts.redact,
    note: opts.note,
    extraFiles: opts.extraFiles,
    deps: { readDesktopEnv, logger: opts.logger },
  });
  try {
    mkdirSync(dirname(opts.outputPath), { recursive: true });
    await writeBundle({ collected, outputPath: opts.outputPath });
    const scrub = collected.manifest.redaction.secretScrub;
    return {
      zipPath: opts.outputPath,
      summary: {
        level: 'full',
        systemWide: false,
        projectSlug: resolveProjectSlug(projectDir, opts.logger),
        files: collected.manifest.files.map((f) => f.path),
        redactions: scrub?.redactions ?? [],
        redactedLineCount: scrub?.redactedLineCount ?? 0,
        generatedAt: collected.manifest.createdAt,
      },
    };
  } finally {
    collected.cleanup();
  }
}

/**
 * Collect a bug-report bundle at the requested detail level and write it as
 * a zip to `outputPath`.
 *
 * - `standard`: the `ok bug-report` content set — user-level logs,
 *   per-project lock/spawn-error + local sink logs, sysinfo. No git/server
 *   dependency.
 * - `full`: the `ok diagnose bundle` superset — adds telemetry spans, live
 *   server state, runtime metadata, and doc-name anonymization.
 *   Availability-gated: pieces whose source is missing (no running server,
 *   no shadow repo, no telemetry sink) are omitted without error, and the
 *   bundled manifest inventory reflects what was actually included.
 *
 * Every full-only artifact is project-scoped, so without a `projectDir` both
 * levels produce the same system-wide bundle.
 *
 * With `redact` on, the secret-pattern scrub applies at both levels; the
 * full level additionally hashes doc names and masks the content-dir path
 * (inverse map written as a sidecar next to the zip, never inside it).
 */
export async function collectReportBundle(
  opts: CollectReportBundleOptions,
): Promise<ReportBundleResult> {
  const { projectDir } = opts;
  const readDesktopEnv = opts.readDesktopEnv ?? defaultReadDesktopEnv;
  if (opts.level === 'full' && projectDir !== undefined) {
    return collectFullBundle(opts, projectDir, readDesktopEnv);
  }
  const { zipPath, summary } = await collectStandardBundle({
    projectDir,
    redact: opts.redact,
    outputPath: opts.outputPath,
    userLogsDir: opts.userLogsDir,
    logger: opts.logger,
    note: opts.note,
    extraFiles: opts.extraFiles,
    desktop: readDesktopEnv(),
  });
  return {
    zipPath,
    summary: {
      level: opts.level,
      systemWide: projectDir === undefined,
      projectSlug: summary.projectSlug,
      files: summary.files,
      redactions: summary.redactions,
      redactedLineCount: summary.redactedLineCount,
      generatedAt: summary.generatedAt,
    },
  };
}

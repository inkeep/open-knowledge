/**
 * Standard bug-report capture — the `ok bug-report` content set (user-level
 * logs, per-project lock/spawn-error files, local sink logs, sysinfo) packaged
 * into a redacted zip. Extracted from `bug-report.ts` for the same reason as
 * `bug-report-redact.ts`: `bug-report.ts` imports `cli.ts`, which parses argv
 * at module load, so it can't be imported by tests or by Electron main.
 * Desktop calls this in-process instead of shelling out to the CLI.
 *
 * CLI-facing concerns (stdout path echo, stderr redaction notice, Finder
 * reveal) stay in `bug-report.ts` — this module only collects and packages.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { freemem, homedir, type as osType, platform, release, totalmem, uptime } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { BundleManifest, BundleRedaction } from '@inkeep/open-knowledge-core';
import { withHiddenWindowsConsole } from '@inkeep/open-knowledge-server';
import type { ZipFile } from 'yazl';
// Keep this import type-only: `diagnose/bundle.ts` imports from this module
// too, so a value import in either direction would form a runtime cycle.
import type { DesktopMetadata } from '../diagnose/bundle.ts';
import { redactContent, SECRET_PATTERN_NAMES } from './bug-report-redact.ts';

/**
 * Where `ok bug-report` (and the desktop report flow) write bundles by
 * default. A function, not a module-level constant: `homedir()` is
 * env-sensitive, and freezing it at import time makes the value depend on
 * module load order (test processes mutate HOME).
 */
export function okBugReportsDir(): string {
  return join(homedir(), '.ok', 'bug-reports');
}

export function defaultBugReportZipPath(now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return join(okBugReportsDir(), `${timestamp}-bugreport.zip`);
}

/** Structural subset of a pino logger, so callers outside the CLI can inject their own. */
export interface BundleLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

/** File copied byte-for-byte into the bundle under `extra/` — never text-scrubbed. */
export interface BundleExtraFile {
  sourcePath: string;
  /** Zip entry name under `extra/`; defaults to the source file's basename. */
  zipName?: string;
}

export interface CollectStandardBundleOptions {
  /**
   * Project directory whose `.ok/local` artifacts (lock/spawn-error, local
   * sink logs) are captured and whose slug scopes the user-log filter. Omit
   * for a system-wide bundle: user-level logs + sysinfo only.
   */
  projectDir?: string;
  /** Apply the secret-pattern scrub to every bundled file. */
  redact: boolean;
  /** Zip destination; parent directories are created as needed. */
  outputPath: string;
  /** Override the user-level logs directory (defaults to `~/.ok/logs`). */
  userLogsDir?: string;
  /** User note added as `note.txt`, scrubbed like any content file when `redact` is on. */
  note?: string;
  /** Extra files (e.g. an opted-in crash minidump) added under `extra/`. */
  extraFiles?: BundleExtraFile[];
  /**
   * Desktop host metadata recorded in `sysinfo.json` (and, through it, the
   * manifest). `null`/omitted reads as "not an Electron host" — mirroring the
   * full-level bundle's `host.desktop: null` convention.
   */
  desktop?: DesktopMetadata | null;
  logger?: BundleLogger;
}

interface StandardBundleSummary {
  projectSlug: string | null;
  /** Zip entry names of the captured content files (mirrors MANIFEST.json `files`). */
  files: string[];
  /** Per-file redaction audit (mirrors MANIFEST.json `redactions`). */
  redactions: BundleRedaction[];
  /** Total lines scrubbed across all files. */
  redactedLineCount: number;
  generatedAt: string;
}

export interface StandardBundleResult {
  zipPath: string;
  summary: StandardBundleSummary;
}

export function resolveProjectSlug(cwd: string, logger?: BundleLogger): string | null {
  const configPath = join(cwd, '.ok', 'config.yml');
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf8');
      const nameMatch = content.match(/^\s*name:\s*['"]?(.+?)['"]?\s*$/m);
      if (nameMatch?.[1]) return nameMatch[1];
    } catch (err) {
      // A malformed/unreadable .ok/config.yml falls back to a path-hash slug
      // (or null), but log it so a missing/wrong project slug in the bundle is
      // diagnosable rather than silent — same rationale as resolveContentDir.
      logger?.warn(
        { configPath, err: err instanceof Error ? err.message : String(err) },
        'bug-report: failed to read .ok/config.yml for project slug; using path-hash fallback',
      );
    }
  }

  if (existsSync(join(cwd, '.ok'))) {
    return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 12);
  }

  return null;
}

function collectSysinfo(): Record<string, unknown> {
  const info: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    platform: platform(),
    osType: osType(),
    osRelease: release(),
    hostname: '[redacted]',
    uptime: uptime(),
    freeMem: freemem(),
    totalMem: totalmem(),
    nodeVersion: process.version,
    bunVersion: process.versions.bun ?? null,
    v8Version: process.versions.v8 ?? null,
    pid: process.pid,
  };

  try {
    const ver = execSync(
      'sw_vers -productVersion 2>/dev/null',
      withHiddenWindowsConsole({ encoding: 'utf8' }),
    ).trim();
    info.macosVersion = ver;
  } catch {}

  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      info.okVersion = pkg.version;
    }
  } catch {}

  return info;
}

function collectLogs(projectSlug: string | null, logsDir: string): { files: string[] } {
  if (!existsSync(logsDir)) return { files: [] };

  let files = readdirSync(logsDir)
    .filter((f) => f.endsWith('.log') || /\.log\.\d+$/.test(f))
    .map((f) => join(logsDir, f));

  if (projectSlug && files.length > 0) {
    const filtered = files.filter((f) => {
      try {
        const content = readFileSync(f, 'utf8');
        return content.includes(`"project":"${projectSlug}"`);
      } catch {
        return true;
      }
    });
    if (filtered.length > 0) files = filtered;
  }

  return { files };
}

function collectLockDir(cwd: string): { files: string[] } {
  const lockDir = join(cwd, '.ok', 'local');
  if (!existsSync(lockDir)) return { files: [] };

  const candidates = ['server.lock', 'last-spawn-error.log'];
  const found = candidates.map((f) => join(lockDir, f)).filter((f) => existsSync(f));

  return { files: found };
}

// Server-side diagnostic logs from the runtime pino file sink — including the
// `renderer` subsystem fed by the web client-log ingest (`/api/client-logs`).
// Path + filenames mirror `logsCurrentPath`/`logsPreviousPath` in
// `packages/server/src/telemetry-file-sink.ts`; hardcoded here so the CLI
// bug-report path doesn't pull in the server module graph.
function collectLocalSinkLogs(cwd: string): { files: string[] } {
  const logsDir = join(cwd, '.ok', 'local', 'logs');
  if (!existsSync(logsDir)) return { files: [] };

  const candidates = ['server-current.jsonl', 'server-prev.jsonl'];
  const found = candidates.map((f) => join(logsDir, f)).filter((f) => existsSync(f));

  return { files: found };
}

function addTextEntry(args: {
  zipfile: ZipFile;
  name: string;
  content: string;
  redact: boolean;
  bundleFiles: string[];
  redactions: BundleRedaction[];
}): void {
  if (args.redact) {
    const { redacted, patterns, lineCount } = redactContent(args.content);
    args.zipfile.addBuffer(Buffer.from(redacted, 'utf8'), args.name);
    args.bundleFiles.push(args.name);
    if (patterns.length > 0) {
      args.redactions.push({ file: args.name, lineCount, patterns });
    }
  } else {
    args.zipfile.addBuffer(Buffer.from(args.content, 'utf8'), args.name);
    args.bundleFiles.push(args.name);
  }
}

function addContentFiles(args: {
  zipfile: ZipFile;
  files: string[];
  prefix: string;
  redact: boolean;
  bundleFiles: string[];
  redactions: BundleRedaction[];
  logger?: BundleLogger;
}): void {
  for (const file of args.files) {
    try {
      addTextEntry({
        zipfile: args.zipfile,
        name: `${args.prefix}/${basename(file)}`,
        content: readFileSync(file, 'utf8'),
        redact: args.redact,
        bundleFiles: args.bundleFiles,
        redactions: args.redactions,
      });
    } catch (err) {
      // A file we listed but can't read is dropped rather than aborting the
      // whole report; log it so the omission is diagnosable — the bundled
      // MANIFEST lists only what was written, never what was skipped.
      args.logger?.warn(
        { file, prefix: args.prefix, err: err instanceof Error ? err.message : String(err) },
        'bug-report: skipped unreadable file',
      );
    }
  }
}

/**
 * Collect the standard bug-report content set and write it as a zip to
 * `outputPath`. Returns the zip path plus a summary mirroring the bundled
 * MANIFEST.json (file inventory + redaction audit).
 */
export async function collectStandardBundle(
  opts: CollectStandardBundleOptions,
): Promise<StandardBundleResult> {
  const { redact, outputPath, logger } = opts;
  const userLogsDir = opts.userLogsDir ?? join(homedir(), '.ok', 'logs');
  const projectSlug = opts.projectDir ? resolveProjectSlug(opts.projectDir, logger) : null;

  mkdirSync(dirname(outputPath), { recursive: true });

  logger?.info({ projectSlug }, 'gathering diagnostic data');

  const sysinfo = collectSysinfo();
  // Always present so a recipient can distinguish "not an Electron host"
  // (null) from a bundle predating the field (absent).
  sysinfo.desktop = opts.desktop ?? null;
  const { files: logFiles } = collectLogs(projectSlug, userLogsDir);
  const { files: lockFiles } = opts.projectDir ? collectLockDir(opts.projectDir) : { files: [] };
  const { files: localSinkFiles } = opts.projectDir
    ? collectLocalSinkLogs(opts.projectDir)
    : { files: [] };

  logger?.info(
    {
      logFileCount: logFiles.length,
      lockFileCount: lockFiles.length,
      localSinkFileCount: localSinkFiles.length,
    },
    'files collected',
  );

  const redactions: BundleRedaction[] = [];
  const bundleFiles: string[] = [];

  const { ZipFile } = await import('yazl');
  const zipfile = new ZipFile();

  addContentFiles({
    zipfile,
    files: logFiles,
    prefix: 'logs',
    redact,
    bundleFiles,
    redactions,
    logger,
  });
  addContentFiles({
    zipfile,
    files: lockFiles,
    prefix: 'lockdir',
    redact,
    bundleFiles,
    redactions,
    logger,
  });
  addContentFiles({
    zipfile,
    files: localSinkFiles,
    prefix: 'local-logs',
    redact,
    bundleFiles,
    redactions,
    logger,
  });

  for (const extra of opts.extraFiles ?? []) {
    try {
      // Raw bytes on purpose: extras are binary payloads (crash minidumps)
      // that the text scrub would corrupt.
      const raw = readFileSync(extra.sourcePath);
      const name = `extra/${extra.zipName ?? basename(extra.sourcePath)}`;
      zipfile.addBuffer(raw, name);
      bundleFiles.push(name);
    } catch (err) {
      // Unlike the best-effort log/lock sources, an extra is an artifact the
      // user explicitly opted into sharing — its absence must be traceable,
      // not silent.
      logger?.warn(
        { sourcePath: extra.sourcePath, err },
        'extra file unreadable; omitted from bundle',
      );
    }
  }

  if (opts.note) {
    addTextEntry({
      zipfile,
      name: 'note.txt',
      content: opts.note,
      redact,
      bundleFiles,
      redactions,
    });
  }

  const sysinfoJson = JSON.stringify(sysinfo, null, 2);
  zipfile.addBuffer(Buffer.from(sysinfoJson, 'utf8'), 'sysinfo.json');
  bundleFiles.push('sysinfo.json');

  const manifest: BundleManifest = {
    generatedAt: new Date().toISOString(),
    disciplineVersion: '1.0.0',
    projectSlug,
    files: bundleFiles,
    redactions,
    sysinfo: sysinfo as Record<string, import('@inkeep/open-knowledge-core').Loggable>,
  };
  zipfile.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'MANIFEST.json');

  const totalRedacted = redactions.reduce((sum, r) => sum + r.lineCount, 0);
  const readme = [
    '# Bug Report Bundle',
    '',
    `Generated: ${manifest.generatedAt}`,
    `Project: ${projectSlug ?? '(unscoped)'}`,
    `Discipline version: ${manifest.disciplineVersion}`,
    '',
    '## Contents',
    '',
    ...bundleFiles.map((f) => `- ${f}`),
    '',
    '## Privacy',
    '',
    ...(redact
      ? [
          'This bundle was auto-redacted before packaging.',
          `Patterns checked: ${SECRET_PATTERN_NAMES.join(', ')}`,
          totalRedacted > 0
            ? `${totalRedacted} line(s) were scrubbed across ${redactions.length} file(s).`
            : 'No redactions were needed.',
          'See MANIFEST.json for the full redaction audit report.',
          '',
          'This bundle is safe to attach to a GitHub issue.',
        ]
      : ['Redaction was disabled for this bundle; file contents are unmodified.']),
  ].join('\n');
  zipfile.addBuffer(Buffer.from(readme, 'utf8'), 'README.md');

  zipfile.end();
  const output = createWriteStream(outputPath);
  zipfile.outputStream.pipe(output);
  await new Promise<void>((resolvePromise, reject) => {
    output.on('close', resolvePromise);
    output.on('error', reject);
  });

  logger?.info(
    { bundlePath: outputPath, fileCount: bundleFiles.length, redactionCount: totalRedacted },
    'bundle written',
  );

  return {
    zipPath: outputPath,
    summary: {
      projectSlug,
      files: bundleFiles,
      redactions,
      redactedLineCount: totalRedacted,
      generatedAt: manifest.generatedAt,
    },
  };
}

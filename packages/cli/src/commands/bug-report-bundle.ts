import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { freemem, homedir, type as osType, platform, release, totalmem, uptime } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  type BundleManifest,
  type BundleRedaction,
  REPORT_SENT_MARKER_SUFFIX,
  REPORT_SIDECAR_BUNDLE_DIR,
  SERVER_CRASH_LOG,
} from '@inkeep/open-knowledge-core';
import { withHiddenWindowsConsole } from '@inkeep/open-knowledge-server';
import type { ZipFile } from 'yazl';
import type { DesktopMetadata } from '../diagnose/bundle.ts';
import {
  type DiagnosticReportCollection,
  prepareDiagnosticReportText,
  renderDiagnosticReportsStatus,
} from '../diagnose/diagnostic-reports.ts';
import type { LanguageMetadata } from '../report-language.ts';
import { redactContent, SECRET_PATTERN_NAMES } from './bug-report-redact.ts';
import { DESKTOP_BUNDLE_ID } from './desktop-dispatch.ts';

export function okBugReportsDir(): string {
  return join(homedir(), '.ok', 'bug-reports');
}

export function defaultBugReportZipPath(now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const dir = okBugReportsDir();
  const base = `${timestamp}-bugreport`;
  let candidate = join(dir, `${base}.zip`);
  for (let counter = 2; existsSync(candidate); counter += 1) {
    candidate = join(dir, `${base}-${counter}.zip`);
  }
  return candidate;
}

export interface BundleLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface BundleExtraFile {
  sourcePath: string;
  zipName?: string;
}

export interface CollectStandardBundleOptions {
  projectDir?: string;
  redact: boolean;
  revealDocNames?: boolean;
  outputPath: string;
  userLogsDir?: string;
  shipItLogFiles?: string[];
  bugReportLedgerFiles?: string[];
  diagnosticReports?: DiagnosticReportCollection;
  note?: string;
  extraFiles?: BundleExtraFile[];
  desktop?: DesktopMetadata | null;
  language?: LanguageMetadata | null;
  logger?: BundleLogger;
}

interface StandardBundleSummary {
  projectSlug: string | null;
  files: string[];
  redactions: BundleRedaction[];
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
      logger?.warn(
        { configPath, err },
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

const USER_LOG_FAMILIES = [
  { prefix: 'cli', projectTagged: true },
  { prefix: 'desktop', projectTagged: false },
  { prefix: 'mcp', projectTagged: false },
] as const satisfies readonly { prefix: string; projectTagged: boolean }[];

function isProjectTaggable(file: string): boolean {
  const name = basename(file);
  return USER_LOG_FAMILIES.some((f) => f.projectTagged && name.startsWith(`${f.prefix}.`));
}

export function collectUserLogFiles(projectSlug: string | null, logsDir: string): string[] {
  return collectLogs(projectSlug, logsDir).files;
}

export { DESKTOP_BUNDLE_ID };

const SHIPIT_LOG_STREAMS = ['ShipIt_stderr.log', 'ShipIt_stdout.log'] as const;

const SHIPIT_LOG_FILES_PER_STREAM = 4;

export function collectShipItLogFiles(
  cachesDir: string,
  bundleId: string = DESKTOP_BUNDLE_ID,
): string[] {
  const shipItDir = join(cachesDir, `${bundleId}.ShipIt`);
  if (!existsSync(shipItDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(shipItDir);
  } catch {
    return [];
  }

  return SHIPIT_LOG_STREAMS.flatMap((stream) =>
    entries
      .map((entry) => {
        if (entry === stream) return { entry, suffix: -1 };
        if (!entry.startsWith(`${stream}.`)) return null;
        const suffix = entry.slice(stream.length + 1);
        return /^\d+$/.test(suffix) ? { entry, suffix: Number(suffix) } : null;
      })
      .filter((match) => match !== null)
      .sort((a, b) => a.suffix - b.suffix)
      .slice(0, SHIPIT_LOG_FILES_PER_STREAM)
      .map((match) => join(shipItDir, match.entry)),
  );
}

export const MAX_BUNDLED_LEDGER_REPORTS = 25;

export function collectBugReportLedgerFiles(bugReportsDir: string): string[] {
  if (!existsSync(bugReportsDir)) return [];
  try {
    const byReport = new Map<string, string[]>();
    for (const name of readdirSync(bugReportsDir)
      .filter((name) => name.endsWith('.yaml'))
      .sort()) {
      const base = name.endsWith(REPORT_SENT_MARKER_SUFFIX)
        ? name.slice(0, -REPORT_SENT_MARKER_SUFFIX.length)
        : name.slice(0, -'.yaml'.length);
      const files = byReport.get(base);
      if (files === undefined) byReport.set(base, [name]);
      else files.push(name);
    }
    return [...byReport.values()]
      .slice(-MAX_BUNDLED_LEDGER_REPORTS)
      .flat()
      .map((name) => join(bugReportsDir, name));
  } catch {
    return [];
  }
}

function collectLogs(
  projectSlug: string | null,
  logsDir: string,
): { files: string[]; excludedByProjectSlug: number } {
  if (!existsSync(logsDir)) return { files: [], excludedByProjectSlug: 0 };

  const files = readdirSync(logsDir)
    .filter((f) => f.endsWith('.log') || /\.log\.\d+$/.test(f))
    .map((f) => join(logsDir, f));

  if (!projectSlug) return { files, excludedByProjectSlug: 0 };

  const taggable = files.filter(isProjectTaggable);
  const unreadable: string[] = [];
  const matching = taggable.filter((f) => {
    try {
      return readFileSync(f, 'utf8').includes(`"project":"${projectSlug}"`);
    } catch {
      unreadable.push(f);
      return false;
    }
  });

  if (matching.length === 0) return { files, excludedByProjectSlug: 0 };

  const kept = new Set([...matching, ...unreadable]);
  return {
    files: files.filter((f) => !isProjectTaggable(f) || kept.has(f)),
    excludedByProjectSlug: taggable.length - kept.size,
  };
}

function collectLockDir(cwd: string): { files: string[] } {
  const lockDir = join(cwd, '.ok', 'local');
  if (!existsSync(lockDir)) return { files: [] };

  const candidates = ['server.lock', 'last-spawn-error.log', SERVER_CRASH_LOG];
  const found = candidates.map((f) => join(lockDir, f)).filter((f) => existsSync(f));

  return { files: found };
}

function collectLocalSinkLogs(cwd: string): { files: string[] } {
  const logsDir = join(cwd, '.ok', 'local', 'logs');
  if (!existsSync(logsDir)) return { files: [] };

  const candidates = ['server-current.jsonl', 'server-prev.jsonl'];
  const found = candidates.map((f) => join(logsDir, f)).filter((f) => existsSync(f));

  return { files: found };
}

function pseudonymizeDocNames(content: string): { text: string; count: number } {
  let count = 0;
  const digests = new Map<string, string>();
  let text = content.replace(
    /("(?:docName|doc\.name|documentName)"\s*:\s*")((?:[^"\\]|\\.)*)"/g,
    (_match, prefix: string, value: string) => {
      count += 1;
      let digest = digests.get(value);
      if (digest === undefined) {
        digest = `doc#${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
        digests.set(value, digest);
      }
      return `${prefix}${digest}"`;
    },
  );

  for (const [value, digest] of [...digests].sort(([a], [b]) => b.length - a.length)) {
    if (value.length === 0 || !text.includes(value)) continue;
    const parts = text.split(value);
    count += parts.length - 1;
    text = parts.join(digest);
  }

  return { text, count };
}

function addTextEntry(args: {
  zipfile: ZipFile;
  name: string;
  content: string;
  redact: boolean;
  revealDocNames?: boolean;
  bundleFiles: string[];
  redactions: BundleRedaction[];
}): void {
  const content = args.revealDocNames ? args.content : pseudonymizeDocNames(args.content).text;
  if (args.redact) {
    const { redacted, patterns, lineCount } = redactContent(content);
    args.zipfile.addBuffer(Buffer.from(redacted, 'utf8'), args.name);
    args.bundleFiles.push(args.name);
    if (patterns.length > 0) {
      args.redactions.push({ file: args.name, lineCount, patterns });
    }
  } else {
    args.zipfile.addBuffer(Buffer.from(content, 'utf8'), args.name);
    args.bundleFiles.push(args.name);
  }
}

function addContentFiles(args: {
  zipfile: ZipFile;
  files: string[];
  prefix: string;
  redact: boolean;
  revealDocNames?: boolean;
  bundleFiles: string[];
  redactions: BundleRedaction[];
  logger?: BundleLogger;
}): void {
  for (const file of args.files) {
    try {
      const raw = readFileSync(file, 'utf8');
      addTextEntry({
        zipfile: args.zipfile,
        name: `${args.prefix}/${basename(file)}`,
        content: file.endsWith('.ips') ? prepareDiagnosticReportText(raw) : raw,
        redact: args.redact,
        revealDocNames: args.revealDocNames,
        bundleFiles: args.bundleFiles,
        redactions: args.redactions,
      });
    } catch (err) {
      args.logger?.warn({ file, prefix: args.prefix, err }, 'bug-report: skipped unreadable file');
    }
  }
}

export async function collectStandardBundle(
  opts: CollectStandardBundleOptions,
): Promise<StandardBundleResult> {
  const { redact, outputPath, logger } = opts;
  const revealDocNames = opts.revealDocNames ?? false;
  const userLogsDir = opts.userLogsDir ?? join(homedir(), '.ok', 'logs');
  const projectSlug = opts.projectDir ? resolveProjectSlug(opts.projectDir, logger) : null;

  mkdirSync(dirname(outputPath), { recursive: true });

  logger?.info({ projectSlug }, 'gathering diagnostic data');

  const sysinfo = collectSysinfo();
  sysinfo.desktop = opts.desktop ?? null;
  sysinfo.language = opts.language ?? null;
  const { files: logFiles, excludedByProjectSlug: logFilesExcludedByProjectSlug } = collectLogs(
    projectSlug,
    userLogsDir,
  );
  const { files: lockFiles } = opts.projectDir ? collectLockDir(opts.projectDir) : { files: [] };
  const { files: localSinkFiles } = opts.projectDir
    ? collectLocalSinkLogs(opts.projectDir)
    : { files: [] };
  const shipItFiles = opts.shipItLogFiles ?? [];
  const diagnosticReportFiles = opts.diagnosticReports?.files ?? [];

  logger?.info(
    {
      logFileCount: logFiles.length,
      logFilesExcludedByProjectSlug,
      lockFileCount: lockFiles.length,
      localSinkFileCount: localSinkFiles.length,
      shipItLogFileCount: shipItFiles.length,
      diagnosticReportCount: diagnosticReportFiles.length,
    },
    'files collected',
  );

  const redactions: BundleRedaction[] = [];
  const bundleFiles: string[] = [];

  const { ZipFile } = await import('yazl');
  const zipfile = new ZipFile();

  addContentFiles({
    zipfile,
    files: [...logFiles, ...shipItFiles],
    prefix: 'logs',
    redact,
    revealDocNames,
    bundleFiles,
    redactions,
    logger,
  });
  addContentFiles({
    zipfile,
    files: lockFiles,
    prefix: 'lockdir',
    redact,
    revealDocNames,
    bundleFiles,
    redactions,
    logger,
  });
  addContentFiles({
    zipfile,
    files: localSinkFiles,
    prefix: 'local-logs',
    redact,
    revealDocNames,
    bundleFiles,
    redactions,
    logger,
  });
  addContentFiles({
    zipfile,
    files: opts.bugReportLedgerFiles ?? [],
    prefix: REPORT_SIDECAR_BUNDLE_DIR,
    redact,
    revealDocNames,
    bundleFiles,
    redactions,
    logger,
  });

  addContentFiles({
    zipfile,
    files: diagnosticReportFiles,
    prefix: 'diagnostic-reports',
    redact,
    revealDocNames,
    bundleFiles,
    redactions,
    logger,
  });

  for (const extra of opts.extraFiles ?? []) {
    try {
      const raw = readFileSync(extra.sourcePath);
      const name = `extra/${extra.zipName ?? basename(extra.sourcePath)}`;
      zipfile.addBuffer(raw, name);
      bundleFiles.push(name);
    } catch (err) {
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
      revealDocNames,
      bundleFiles,
      redactions,
    });
  }

  const diagnosticReportEntryNames = new Set(
    diagnosticReportFiles.map((f) => `diagnostic-reports/${basename(f)}`),
  );
  const diagnosticReportEntries = bundleFiles.filter((f) => diagnosticReportEntryNames.has(f));
  const diagnosticReportsStatus =
    opts.diagnosticReports === undefined
      ? 'not-collected (no collection attempted)'
      : renderDiagnosticReportsStatus(opts.diagnosticReports, diagnosticReportEntries.length);
  zipfile.addBuffer(
    Buffer.from(`${diagnosticReportsStatus}\n`, 'utf8'),
    'state/diagnostic-reports-status.txt',
  );
  bundleFiles.push('state/diagnostic-reports-status.txt');

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

  const shipItEntryNames = new Set(shipItFiles.map((f) => `logs/${basename(f)}`));
  const installerLogEntries = bundleFiles.filter((f) => shipItEntryNames.has(f));

  const ledgerEntryNames = new Set(
    (opts.bugReportLedgerFiles ?? []).map((f) => `${REPORT_SIDECAR_BUNDLE_DIR}/${basename(f)}`),
  );
  const ledgerEntries = bundleFiles.filter((f) => ledgerEntryNames.has(f));

  const userWideLogEntries = projectSlug
    ? bundleFiles.filter(
        (f) => f.startsWith('logs/') && !isProjectTaggable(f) && !shipItEntryNames.has(f),
      )
    : [];

  const diagnosticReportCaveat =
    diagnosticReportEntries.length > 0
      ? [
          'Crash reports under diagnostic-reports/ are rewritten on the way in,',
          'independently of this setting: escaped path separators are normalised',
          'so the scrub above can read them, and the identifiers that link this',
          "machine's bundles to each other are replaced. Nothing else is changed;",
          'they are not byte-identical to the files macOS wrote.',
        ]
      : [];

  const noRedactDisclosure =
    diagnosticReportCaveat.length > 0
      ? [
          'Redaction was disabled for this bundle; file contents are unmodified,',
          'with one exception.',
          ...diagnosticReportCaveat,
        ]
      : ['Redaction was disabled for this bundle; file contents are unmodified.'];

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
    ...(userWideLogEntries.length > 0
      ? [
          'Scope: some collected logs are user-wide rather than project-scoped.',
          'These are written once per machine per day and can contain activity',
          'from other projects open on this machine, including captured console',
          'output:',
          ...userWideLogEntries.map((f) => `- ${f}`),
          '',
        ]
      : []),
    ...(installerLogEntries.length > 0
      ? [
          'Installer logs: written by the macOS update helper rather than by',
          'OpenKnowledge itself, and machine-wide rather than scoped to any one',
          'project. They record the install and update history of this app on',
          'this machine. Only this app is collected, never other applications',
          'that use the same update mechanism:',
          ...installerLogEntries.map((f) => `- ${f}`),
          '',
        ]
      : []),
    ...(diagnosticReportEntries.length > 0
      ? [
          'Crash reports: written by macOS itself rather than by OpenKnowledge,',
          'and machine-wide rather than scoped to any one project. They record',
          'why the operating system ended a process of this app — the signal or',
          'exception, the code-signing verdict, and whatever text the process',
          'left behind as it died. They also carry machine details the OS puts',
          'in every report: the account uid, the Mac model, and the name of the',
          'process that launched this app, which on a managed machine can be',
          "internal tooling. The identifiers that would link this machine's",
          'bundles to each other are replaced before bundling. Only this',
          "app's own reports are collected, never another application's, though",
          'a report of ours still names the processes it ran alongside:',
          ...diagnosticReportEntries.map((f) => `- ${f}`),
          '',
        ]
      : []),
    ...(ledgerEntries.length > 0
      ? [
          'Send history: a small record for each bug report previously generated',
          'on this machine — when it was generated, whether sending it',
          'succeeded, and why it failed if it did. This is what makes a failed',
          'send diagnosable at all. It is machine-wide rather than scoped to',
          'this project, so it names the other projects reports were filed',
          'from. It carries no document content:',
          ...ledgerEntries.map((f) => `- ${f}`),
          '',
        ]
      : []),
    ...(redact
      ? [
          'This bundle was auto-redacted before packaging.',
          `Patterns checked: ${SECRET_PATTERN_NAMES.join(', ')}`,
          totalRedacted > 0
            ? `${totalRedacted} line(s) were scrubbed across ${redactions.length} file(s).`
            : 'No redactions were needed.',
          'See MANIFEST.json for the full redaction audit report.',
          ...diagnosticReportCaveat,
          '',
          'This bundle is safe to attach to a GitHub issue.',
        ]
      : noRedactDisclosure),
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

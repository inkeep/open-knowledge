import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  ReportBundleLevel as CoreReportBundleLevel,
  ReportBundleSummary as CoreReportBundleSummary,
} from '@inkeep/open-knowledge-core';
import { parse as parseYaml } from 'yaml';
import {
  type BundleExtraFile,
  type BundleLogger,
  collectBugReportLedgerFiles,
  collectShipItLogFiles,
  collectStandardBundle,
  collectUserLogFiles,
  okBugReportsDir,
  resolveProjectSlug,
} from './commands/bug-report-bundle.ts';
import {
  collectBundle,
  type DesktopMetadata,
  defaultReadDesktopEnv,
  writeBundle,
} from './diagnose/bundle.ts';
import {
  collectDiagnosticReports,
  type DiagnosticReportCollection,
} from './diagnose/diagnostic-reports.ts';
import { defaultReadLanguage, type LanguageMetadata } from './report-language.ts';
import { isObject } from './utils/is-object.ts';

export type ReportBundleLevel = CoreReportBundleLevel;
export type ReportBundleSummary = CoreReportBundleSummary;

export interface CollectReportBundleOptions {
  level: ReportBundleLevel;
  projectDir?: string;
  note?: string;
  redact: boolean;
  outputPath: string;
  extraFiles?: BundleExtraFile[];
  userLogsDir?: string;
  cachesDir?: string;
  diagnosticReportsDir?: string;
  bugReportsDir?: string;
  logger?: BundleLogger;
  readDesktopEnv?: () => DesktopMetadata | null;
  readLanguage?: () => LanguageMetadata;
}

export interface ReportBundleResult {
  zipPath: string;
  summary: ReportBundleSummary;
}

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
      logger?.warn(
        { configPath, err },
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
  readLanguage: () => LanguageMetadata,
  diagnosticReports: DiagnosticReportCollection,
): Promise<ReportBundleResult> {
  const projectSlug = resolveProjectSlug(projectDir, opts.logger);
  const collected = await collectBundle({
    contentDir: resolveContentDir(projectDir, opts.logger),
    projectDir,
    redact: opts.redact,
    scrubSecrets: opts.redact,
    note: opts.note,
    extraFiles: opts.extraFiles,
    userLogFiles: [
      ...collectUserLogFiles(projectSlug, opts.userLogsDir ?? join(homedir(), '.ok', 'logs')),
      ...collectShipItLogFiles(opts.cachesDir ?? join(homedir(), 'Library', 'Caches')),
    ],
    userStateFiles: collectBugReportLedgerFiles(opts.bugReportsDir ?? okBugReportsDir()),
    diagnosticReports,
    deps: { readDesktopEnv, readLanguage, logger: opts.logger },
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
        projectSlug,
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

export async function collectReportBundle(
  opts: CollectReportBundleOptions,
): Promise<ReportBundleResult> {
  const { projectDir } = opts;
  const readDesktopEnv = opts.readDesktopEnv ?? defaultReadDesktopEnv;
  const readLanguage = opts.readLanguage ?? defaultReadLanguage;
  const resolveDiagnosticReports = (): DiagnosticReportCollection =>
    collectDiagnosticReports(
      opts.diagnosticReportsDir ?? join(homedir(), 'Library', 'Logs', 'DiagnosticReports'),
      new Date(),
    );
  if (opts.level === 'full' && projectDir !== undefined) {
    return collectFullBundle(
      opts,
      projectDir,
      readDesktopEnv,
      readLanguage,
      resolveDiagnosticReports(),
    );
  }
  const { zipPath, summary } = await collectStandardBundle({
    projectDir,
    redact: opts.redact,
    revealDocNames: opts.level === 'full',
    outputPath: opts.outputPath,
    userLogsDir: opts.userLogsDir,
    shipItLogFiles: collectShipItLogFiles(opts.cachesDir ?? join(homedir(), 'Library', 'Caches')),
    bugReportLedgerFiles: collectBugReportLedgerFiles(opts.bugReportsDir ?? okBugReportsDir()),
    diagnosticReports: opts.level === 'full' ? resolveDiagnosticReports() : undefined,
    logger: opts.logger,
    note: opts.note,
    extraFiles: opts.extraFiles,
    desktop: readDesktopEnv(),
    language: readLanguage(),
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

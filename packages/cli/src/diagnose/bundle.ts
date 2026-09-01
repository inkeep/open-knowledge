import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { arch as osArch, platform as osPlatform, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { BundleRedaction as SecretScrubEntry } from '@inkeep/open-knowledge-core';
import {
  REPORT_SIDECAR_BUNDLE_DIR,
  SERVER_CRASH_LOG,
  SERVER_EXIT_LOG,
} from '@inkeep/open-knowledge-core';
import {
  DEFAULT_LOGS_MAX_BYTES,
  DEFAULT_SPANS_MAX_BYTES,
  resolveConfigPath,
} from '@inkeep/open-knowledge-core/server';
import { withHiddenWindowsConsole } from '@inkeep/open-knowledge-server';
import { parse as parseYaml } from 'yaml';
import { ZipFile } from 'yazl';
import type { BundleExtraFile, BundleLogger } from '../commands/bug-report-bundle.ts';
import { redactContent } from '../commands/bug-report-redact.ts';
import { PACKAGE_VERSION } from '../constants.ts';
import { defaultReadLanguage, type LanguageMetadata } from '../report-language.ts';
import { isRotatedLogPath, redactStagedBundle } from './bundle-redact.ts';
import {
  type DiagnosticReportCollection,
  prepareDiagnosticReportText,
  renderDiagnosticReportsStatus,
} from './diagnostic-reports.ts';

type BundleSchemaVersion = 2;

export interface DesktopMetadata {
  electronVersion: string;
  packaged: boolean;
  channel: string;
}

interface BundleFileEntry {
  path: string;
  bytes: number;
  lines: number;
}

interface BundleSecretScrub {
  redactions: SecretScrubEntry[];
  redactedLineCount: number;
}

interface BundleRedaction {
  applied: boolean;
  secretScrub?: BundleSecretScrub;
}

type BundleServerStatus = 'running' | 'not-running';

interface BundleManifest {
  schemaVersion: BundleSchemaVersion;
  createdAt: string;
  ok: {
    version: string;
    nodeVersion: string;
    platform: string;
    arch: string;
  };
  host: {
    desktop: DesktopMetadata | null;
    language: LanguageMetadata | null;
  };
  contentDir: {
    pathSha256: string;
    absolutePath: string;
  };
  telemetry: {
    localSink: {
      enabled: boolean;
      spansMaxBytes: number;
      logsMaxBytes: number;
    };
    otlpPushEnabled: boolean;
  };
  redaction: BundleRedaction;
  serverStatus: BundleServerStatus;
  files: BundleFileEntry[];
}

export interface CollectBundleOpts {
  contentDir: string;
  projectDir?: string;
  processDir?: string;
  redact?: boolean;
  scrubSecrets?: boolean;
  note?: string;
  extraFiles?: BundleExtraFile[];
  userLogFiles?: string[];
  userStateFiles?: string[];
  diagnosticReports?: DiagnosticReportCollection;
  deps?: CollectBundleDeps;
}

export interface CollectBundleDeps {
  fetchAgentPresence?: (port: number) => Promise<string | null>;
  fetchAgentEffects?: (port: number) => Promise<string | null>;
  fetchWatcherRecent?: (port: number) => Promise<string | null>;
  readShadowHead?: (contentDir: string) => string | null;
  readCheckpointRefs?: (contentDir: string) => string | null;
  now?: () => Date;
  okVersion?: () => string;
  readDesktopEnv?: () => DesktopMetadata | null;
  readLanguage?: () => LanguageMetadata;
  readRuntime?: () => { nodeVersion: string; platform: string; arch: string };
  isOtlpPushEnabled?: () => boolean;
  logger?: BundleLogger;
}

interface BundleSummary {
  totalBytes: number;
  fileCount: number;
  docNameCount: number;
  stagedDiagnosticReports: number;
  contentDirVisible: boolean;
  redacted: boolean;
}

export interface CollectedBundle {
  stagingDir: string;
  manifest: BundleManifest;
  summary: BundleSummary;
  cleanup: () => void;
}

export interface WriteBundleOpts {
  collected: CollectedBundle;
  outputPath: string;
}

const TELEMETRY_REL = ['.ok', 'local', 'telemetry'] as const;
const LOGS_REL = ['.ok', 'local', 'logs'] as const;
const LOSS_CAPTURE_REL = ['.ok', 'local', 'loss-capture'] as const;
const SPANS_CURRENT = 'spans-current.jsonl';
const SPANS_PREVIOUS = 'spans-prev.jsonl';
const LOGS_CURRENT = 'server-current.jsonl';
const LOGS_PREVIOUS = 'server-prev.jsonl';
const LOSS_CURRENT = 'loss-current.jsonl';
const LOSS_PREVIOUS = 'loss-prev.jsonl';

function spansCurrentPath(projectDir: string): string {
  return join(projectDir, ...TELEMETRY_REL, SPANS_CURRENT);
}

function spansPreviousPath(projectDir: string): string {
  return join(projectDir, ...TELEMETRY_REL, SPANS_PREVIOUS);
}

function logsCurrentPath(projectDir: string): string {
  return join(projectDir, ...LOGS_REL, LOGS_CURRENT);
}

function logsPreviousPath(projectDir: string): string {
  return join(projectDir, ...LOGS_REL, LOGS_PREVIOUS);
}

function lossCaptureCurrentPath(projectDir: string): string {
  return join(projectDir, ...LOSS_CAPTURE_REL, LOSS_CURRENT);
}

function lossCapturePreviousPath(projectDir: string): string {
  return join(projectDir, ...LOSS_CAPTURE_REL, LOSS_PREVIOUS);
}

export const _pathHelpersForTests = {
  spansCurrentPath,
  spansPreviousPath,
  logsCurrentPath,
  logsPreviousPath,
  lossCaptureCurrentPath,
  lossCapturePreviousPath,
};

const AGENT_PRESENCE_TIMEOUT_MS = 1000;
const SHADOW_GIT_LOG_LIMIT = 50;
const CHECKPOINT_REF_LIMIT = 50;

async function defaultFetchAgentPresence(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/metrics/agent-presence`, {
      signal: AbortSignal.timeout(AGENT_PRESENCE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function defaultFetchAgentEffects(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/metrics/agent-effects`, {
      signal: AbortSignal.timeout(AGENT_PRESENCE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function defaultFetchWatcherRecent(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/metrics/watcher-recent`, {
      signal: AbortSignal.timeout(AGENT_PRESENCE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function watcherRecentToJsonl(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const decisions = (parsed as { decisions?: unknown }).decisions;
    if (!Array.isArray(decisions)) return null;
    if (decisions.length === 0) return '';
    return `${decisions.map((decision) => JSON.stringify(decision)).join('\n')}\n`;
  } catch {
    return null;
  }
}

function defaultReadShadowHead(contentDir: string): string | null {
  const shadowDir = join(contentDir, '.git', 'ok');
  if (!existsSync(shadowDir)) return null;
  const result = spawnSync(
    'git',
    ['-C', shadowDir, 'log', '--oneline', `-${SHADOW_GIT_LOG_LIMIT}`],
    withHiddenWindowsConsole({ encoding: 'utf-8', timeout: 2000 }),
  );
  if (result.error || result.status !== 0) return null;
  return result.stdout ?? '';
}

export const CHECKPOINT_REF_GIT_FORMAT =
  '%(refname)%09%(creatordate:iso-strict)%09%(contents:subject)';

function defaultReadCheckpointRefs(contentDir: string): string | null {
  const shadowDir = join(contentDir, '.git', 'ok');
  if (!existsSync(shadowDir)) return null;
  const result = spawnSync(
    'git',
    [
      '-C',
      shadowDir,
      'for-each-ref',
      '--sort=-creatordate',
      `--count=${CHECKPOINT_REF_LIMIT}`,
      `--format=${CHECKPOINT_REF_GIT_FORMAT}`,
      'refs/checkpoints/',
    ],
    withHiddenWindowsConsole({ encoding: 'utf-8', timeout: 2000 }),
  );
  if (result.error || result.status !== 0) return null;
  return result.stdout ?? '';
}

export function defaultReadDesktopEnv(): DesktopMetadata | null {
  const electronVersion = process.env.OK_DESKTOP_VERSION;
  const packagedRaw = process.env.OK_DESKTOP_PACKAGED;
  const channel = process.env.OK_DESKTOP_CHANNEL;
  if (electronVersion === undefined || packagedRaw === undefined || channel === undefined) {
    return null;
  }
  return {
    electronVersion,
    packaged: packagedRaw === '1' || packagedRaw.toLowerCase() === 'true',
    channel,
  };
}

function defaultReadRuntime(): { nodeVersion: string; platform: string; arch: string } {
  return {
    nodeVersion: process.version,
    platform: osPlatform(),
    arch: osArch(),
  };
}

function defaultIsOtlpPushEnabled(): boolean {
  return process.env.OTEL_SDK_DISABLED === 'false';
}

interface LocalSinkBlock {
  enabled: boolean;
  spansMaxBytes: number;
  logsMaxBytes: number;
}

interface RawLocalSinkBlock {
  enabled?: unknown;
  spans?: { maxBytes?: unknown } | null;
  logs?: { maxBytes?: unknown } | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readRawSinkBlock(absPath: string): RawLocalSinkBlock {
  if (!existsSync(absPath)) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(absPath, 'utf-8'));
  } catch (err) {
    console.warn(
      `[ok diagnose bundle] failed to parse ${absPath} for manifest config; ` +
        `manifest will report schema defaults. Reason: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
  if (!isObject(parsed)) return {};
  const telemetry = parsed.telemetry;
  if (!isObject(telemetry)) return {};
  const localSink = telemetry.localSink;
  if (!isObject(localSink)) return {};
  return localSink as RawLocalSinkBlock;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readMaxBytes(block: { maxBytes?: unknown } | null | undefined): number | undefined {
  if (!isObject(block)) return undefined;
  return readPositiveNumber(block.maxBytes);
}

function resolveLocalSinkBlock(projectDir: string): LocalSinkBlock {
  const projectSink = readRawSinkBlock(resolveConfigPath('project', projectDir));
  const localSink = readRawSinkBlock(resolveConfigPath('project-local', projectDir));
  const enabled = readBoolean(localSink.enabled) ?? readBoolean(projectSink.enabled) ?? true;
  const spansMaxBytes =
    readMaxBytes(localSink.spans) ?? readMaxBytes(projectSink.spans) ?? DEFAULT_SPANS_MAX_BYTES;
  const logsMaxBytes =
    readMaxBytes(localSink.logs) ?? readMaxBytes(projectSink.logs) ?? DEFAULT_LOGS_MAX_BYTES;
  return { enabled, spansMaxBytes, logsMaxBytes };
}

function hashContentDirPath(absolutePath: string): string {
  return createHash('sha256').update(absolutePath).digest('hex');
}

function countLines(filePath: string): number {
  const buf = readFileSync(filePath);
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) count++;
  }
  return count;
}

const DOC_NAME_MARKERS = ['"doc.name"', '"docName"'] as const;

function countDocNameOccurrences(filePath: string): number {
  const content = readFileSync(filePath, 'utf-8');
  let count = 0;
  for (const marker of DOC_NAME_MARKERS) {
    let idx = content.indexOf(marker);
    while (idx !== -1) {
      count++;
      idx = content.indexOf(marker, idx + marker.length);
    }
  }
  return count;
}

function stageFileIfPresent(srcPath: string, destPath: string): boolean {
  if (!existsSync(srcPath)) return false;
  try {
    mkdirSync(dirname(destPath), { recursive: true });
    if (srcPath.endsWith('.ips')) {
      writeFileSync(destPath, prepareDiagnosticReportText(readFileSync(srcPath, 'utf-8')));
    } else {
      cpSync(srcPath, destPath);
    }
    return true;
  } catch {
    return false;
  }
}

function walkStagedFiles(stagingDir: string): string[] {
  const results: string[] = [];
  const recurse = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  };
  recurse(stagingDir);
  return results.sort();
}

const LINE_COUNTED_EXTENSIONS = new Set(['.jsonl']);

function shouldCountLines(relPath: string): boolean {
  const lastDot = relPath.lastIndexOf('.');
  if (lastDot === -1) return false;
  return LINE_COUNTED_EXTENSIONS.has(relPath.slice(lastDot));
}

export const SECRET_SCRUB_EXTENSIONS = new Set([
  '.jsonl',
  '.json',
  '.txt',
  '.log',
  '.lock',
  '.yaml',
  '.yml',
  '.ips',
]);

function isSecretScrubbable(relPath: string): boolean {
  if (isRotatedLogPath(relPath)) return true;
  const lastDot = relPath.lastIndexOf('.');
  if (lastDot === -1) return false;
  return SECRET_SCRUB_EXTENSIONS.has(relPath.slice(lastDot));
}

function scrubStagedSecrets(stagingDir: string): BundleSecretScrub {
  const redactions: SecretScrubEntry[] = [];
  for (const absPath of walkStagedFiles(stagingDir)) {
    const relPath = relativeZipPath(stagingDir, absPath);
    if (!isSecretScrubbable(relPath)) continue;
    const { redacted, patterns, lineCount } = redactContent(readFileSync(absPath, 'utf-8'));
    if (patterns.length === 0) continue;
    writeFileSync(absPath, redacted);
    redactions.push({ file: relPath, lineCount, patterns });
  }
  return {
    redactions,
    redactedLineCount: redactions.reduce((sum, r) => sum + r.lineCount, 0),
  };
}

function relativeZipPath(stagingDir: string, absPath: string): string {
  return relative(stagingDir, absPath).split(sep).join('/');
}

export async function collectBundle(opts: CollectBundleOpts): Promise<CollectedBundle> {
  const contentDir = resolve(opts.contentDir);
  const projectDir = resolve(opts.projectDir ?? opts.contentDir);
  const deps = opts.deps ?? {};
  const fetchAgentPresence = deps.fetchAgentPresence ?? defaultFetchAgentPresence;
  const fetchAgentEffects = deps.fetchAgentEffects ?? defaultFetchAgentEffects;
  const fetchWatcherRecent = deps.fetchWatcherRecent ?? defaultFetchWatcherRecent;
  const readShadowHead = deps.readShadowHead ?? defaultReadShadowHead;
  const readCheckpointRefs = deps.readCheckpointRefs ?? defaultReadCheckpointRefs;
  const now = deps.now ?? (() => new Date());
  const okVersion = deps.okVersion ?? (() => PACKAGE_VERSION);
  const readDesktopEnv = deps.readDesktopEnv ?? defaultReadDesktopEnv;
  const readLanguage = deps.readLanguage ?? defaultReadLanguage;
  const readRuntime = deps.readRuntime ?? defaultReadRuntime;
  const isOtlpPushEnabled = deps.isOtlpPushEnabled ?? defaultIsOtlpPushEnabled;

  const stagingDir = mkdtempSync(join(tmpdir(), 'ok-bundle-'));
  try {
    mkdirSync(join(stagingDir, 'telemetry'), { recursive: true });
    mkdirSync(join(stagingDir, 'logs'), { recursive: true });
    mkdirSync(join(stagingDir, 'state'), { recursive: true });

    stageFileIfPresent(spansCurrentPath(projectDir), join(stagingDir, 'telemetry', SPANS_CURRENT));
    stageFileIfPresent(
      spansPreviousPath(projectDir),
      join(stagingDir, 'telemetry', SPANS_PREVIOUS),
    );
    stageFileIfPresent(logsCurrentPath(projectDir), join(stagingDir, 'logs', LOGS_CURRENT));
    stageFileIfPresent(logsPreviousPath(projectDir), join(stagingDir, 'logs', LOGS_PREVIOUS));
    for (const userLogPath of opts.userLogFiles ?? []) {
      stageFileIfPresent(userLogPath, join(stagingDir, 'logs', basename(userLogPath)));
    }
    for (const userStatePath of opts.userStateFiles ?? []) {
      stageFileIfPresent(
        userStatePath,
        join(stagingDir, REPORT_SIDECAR_BUNDLE_DIR, basename(userStatePath)),
      );
    }
    let stagedDiagnosticReports = 0;
    for (const reportPath of opts.diagnosticReports?.files ?? []) {
      if (
        stageFileIfPresent(reportPath, join(stagingDir, 'diagnostic-reports', basename(reportPath)))
      ) {
        stagedDiagnosticReports += 1;
      }
    }

    const lockDir = join(projectDir, '.ok', 'local');
    const lockPath = join(lockDir, 'server.lock');
    let serverStatus: BundleServerStatus = 'not-running';
    let serverStatusReason = 'no server.lock';
    let lockPort: number | null = null;

    if (existsSync(lockPath)) {
      stageFileIfPresent(lockPath, join(stagingDir, 'state', 'server.lock'));
      try {
        const lockContent = readFileSync(lockPath, 'utf-8');
        const lock = JSON.parse(lockContent) as { port?: number };
        if (typeof lock.port === 'number') {
          lockPort = lock.port;
        } else {
          serverStatusReason = 'lock present but no port';
        }
      } catch {
        serverStatusReason = 'lock present but unparseable';
      }
    }

    if (lockPort !== null) {
      const presence = await fetchAgentPresence(lockPort);
      if (presence !== null) {
        writeFileSync(join(stagingDir, 'state', 'agent-presence.json'), presence);
        serverStatus = 'running';
        serverStatusReason = '';
      } else {
        serverStatusReason = `agent-presence endpoint at :${lockPort} unreachable`;
      }
      const agentEffects = await fetchAgentEffects(lockPort);
      if (agentEffects !== null) {
        writeFileSync(join(stagingDir, 'state', 'agent-effects.json'), agentEffects);
      }
      const watcherRecent = await fetchWatcherRecent(lockPort);
      if (watcherRecent !== null) {
        const jsonl = watcherRecentToJsonl(watcherRecent);
        if (jsonl !== null) {
          writeFileSync(join(stagingDir, 'state', 'watcher-recent.jsonl'), jsonl);
        }
      }
    }

    const shadowHead = readShadowHead(contentDir);
    if (shadowHead !== null) {
      writeFileSync(join(stagingDir, 'state', 'shadow-head.txt'), shadowHead);
    }

    const checkpointRefs = readCheckpointRefs(contentDir);
    if (checkpointRefs !== null) {
      writeFileSync(join(stagingDir, 'state', 'checkpoint-refs.txt'), checkpointRefs);
    }

    stageFileIfPresent(lossCaptureCurrentPath(projectDir), join(stagingDir, 'state', LOSS_CURRENT));
    stageFileIfPresent(
      lossCapturePreviousPath(projectDir),
      join(stagingDir, 'state', LOSS_PREVIOUS),
    );

    stageFileIfPresent(
      join(lockDir, 'last-spawn-error.log'),
      join(stagingDir, 'state', 'last-spawn-error.log'),
    );

    stageFileIfPresent(join(lockDir, SERVER_EXIT_LOG), join(stagingDir, 'state', SERVER_EXIT_LOG));

    stageFileIfPresent(
      join(lockDir, SERVER_CRASH_LOG),
      join(stagingDir, 'state', SERVER_CRASH_LOG),
    );

    const runtime = readRuntime();
    const desktop = readDesktopEnv();
    const language = readLanguage();
    const runtimeJson = {
      ok: {
        version: okVersion(),
        nodeVersion: runtime.nodeVersion,
        platform: runtime.platform,
        arch: runtime.arch,
      },
      host: { desktop, language },
    };
    writeFileSync(
      join(stagingDir, 'state', 'runtime.json'),
      `${JSON.stringify(runtimeJson, null, 2)}\n`,
    );

    const statusBody =
      serverStatus === 'running' ? 'running\n' : `not-running (${serverStatusReason})\n`;
    writeFileSync(join(stagingDir, 'state', 'server-status.txt'), statusBody);

    const diagnosticReportsStatus =
      opts.diagnosticReports === undefined
        ? 'not-collected (no collection attempted)'
        : renderDiagnosticReportsStatus(opts.diagnosticReports, stagedDiagnosticReports);
    writeFileSync(
      join(stagingDir, 'state', 'diagnostic-reports-status.txt'),
      `${diagnosticReportsStatus}\n`,
    );

    if (opts.processDir && existsSync(opts.processDir)) {
      const processDest = join(stagingDir, 'process');
      mkdirSync(processDest, { recursive: true });
      cpSync(opts.processDir, processDest, { recursive: true });
    }

    const redactApplied = opts.redact === true;
    if (redactApplied) {
      redactStagedBundle({ stagingDir, contentDir });
    }

    if (opts.note) {
      writeFileSync(join(stagingDir, 'note.txt'), opts.note);
    }

    let secretScrub: BundleSecretScrub | null = null;
    if (opts.scrubSecrets === true) {
      secretScrub = scrubStagedSecrets(stagingDir);
    }

    for (const extra of opts.extraFiles ?? []) {
      const staged = stageFileIfPresent(
        extra.sourcePath,
        join(stagingDir, 'extra', extra.zipName ?? basename(extra.sourcePath)),
      );
      if (!staged) {
        deps.logger?.warn(
          { sourcePath: extra.sourcePath },
          'extra file missing; omitted from bundle',
        );
      }
    }

    const localSink = resolveLocalSinkBlock(projectDir);
    const stagedFiles = walkStagedFiles(stagingDir);
    const files: BundleFileEntry[] = [];
    let totalBytes = 0;
    let docNameCount = 0;
    for (const absPath of stagedFiles) {
      const relPath = relativeZipPath(stagingDir, absPath);
      const bytes = statSync(absPath).size;
      const lines = shouldCountLines(relPath) ? countLines(absPath) : 0;
      files.push({ path: relPath, bytes, lines });
      totalBytes += bytes;
      if (relPath.startsWith('telemetry/') || relPath.startsWith('logs/')) {
        docNameCount += countDocNameOccurrences(absPath);
      }
    }

    const redaction: BundleRedaction = { applied: redactApplied };
    if (secretScrub !== null) {
      redaction.secretScrub = secretScrub;
    }

    const manifest: BundleManifest = {
      schemaVersion: 2,
      createdAt: now().toISOString(),
      ok: {
        version: okVersion(),
        nodeVersion: runtime.nodeVersion,
        platform: runtime.platform,
        arch: runtime.arch,
      },
      host: { desktop, language },
      contentDir: {
        pathSha256: hashContentDirPath(contentDir),
        absolutePath: redactApplied ? '<CONTENT_DIR>' : contentDir,
      },
      telemetry: {
        localSink,
        otlpPushEnabled: isOtlpPushEnabled(),
      },
      redaction,
      serverStatus,
      files,
    };

    writeFileSync(join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const contentDirVisible = stagedFiles.some((absPath) => {
      try {
        return readFileSync(absPath, 'utf-8').includes(contentDir);
      } catch {
        return false;
      }
    });

    const summary: BundleSummary = {
      stagedDiagnosticReports,
      totalBytes,
      fileCount: files.length,
      docNameCount,
      contentDirVisible,
      redacted: redactApplied,
    };

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      rmSync(stagingDir, { recursive: true, force: true });
    };

    return { stagingDir, manifest, summary, cleanup };
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

export async function writeBundle(opts: WriteBundleOpts): Promise<string> {
  const { collected, outputPath } = opts;
  const parent = dirname(outputPath);
  if (!existsSync(parent)) {
    throw new Error(
      `ok diagnose bundle: parent directory does not exist: ${parent}. ` +
        'Create it or pass --out with an existing parent.',
    );
  }

  const zipfile = new ZipFile();
  const absStagedFiles = walkStagedFiles(collected.stagingDir);
  for (const absPath of absStagedFiles) {
    const relPath = relativeZipPath(collected.stagingDir, absPath);
    zipfile.addFile(absPath, relPath);
  }
  zipfile.end();

  const writer = createWriteStream(outputPath);
  zipfile.outputStream.pipe(writer);
  await new Promise<void>((resolveWait, rejectWait) => {
    writer.on('close', resolveWait);
    writer.on('error', rejectWait);
    zipfile.outputStream.on('error', rejectWait);
  });

  return outputPath;
}

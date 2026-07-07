import { spawn as childSpawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { freemem, homedir, type as osType, platform, release, totalmem, uptime } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { BundleManifest, BundleRedaction } from '@inkeep/open-knowledge-core';
import { Command } from 'commander';
import { getCliLogger } from '../cli.ts';
import { redactContent, SECRET_PATTERN_NAMES } from './bug-report-redact.ts';

const OK_LOGS_DIR = join(homedir(), '.ok', 'logs');
const OK_BUGS_DIR = join(homedir(), '.ok', 'bug-reports');

function resolveProjectSlug(cwd: string): string | null {
  const configPath = join(cwd, '.ok', 'config.yml');
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf8');
      const nameMatch = content.match(/^\s*name:\s*['"]?(.+?)['"]?\s*$/m);
      if (nameMatch?.[1]) return nameMatch[1];
    } catch {}
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
    const ver = execSync('sw_vers -productVersion 2>/dev/null', { encoding: 'utf8' }).trim();
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

function collectLogs(projectSlug: string | null): { files: string[]; dir: string } {
  if (!existsSync(OK_LOGS_DIR)) return { files: [], dir: OK_LOGS_DIR };

  let files = readdirSync(OK_LOGS_DIR)
    .filter((f) => f.endsWith('.log') || /\.log\.\d+$/.test(f))
    .map((f) => join(OK_LOGS_DIR, f));

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

  return { files, dir: OK_LOGS_DIR };
}

function collectLockDir(cwd: string): { files: string[]; dir: string | null } {
  const lockDir = join(cwd, '.ok', 'local');
  if (!existsSync(lockDir)) return { files: [], dir: null };

  const candidates = ['server.lock', 'last-spawn-error.log'];
  const found = candidates.map((f) => join(lockDir, f)).filter((f) => existsSync(f));

  return { files: found, dir: lockDir };
}

// Server-side diagnostic logs from the runtime pino file sink — including the
// `renderer` subsystem fed by the web client-log ingest (`/api/client-logs`).
// Path + filenames mirror `logsCurrentPath`/`logsPreviousPath` in
// `packages/server/src/telemetry-file-sink.ts`; hardcoded here so the CLI
// bug-report path doesn't pull in the server module graph.
function collectLocalSinkLogs(cwd: string): { files: string[]; dir: string | null } {
  const logsDir = join(cwd, '.ok', 'local', 'logs');
  if (!existsSync(logsDir)) return { files: [], dir: null };

  const candidates = ['server-current.jsonl', 'server-prev.jsonl'];
  const found = candidates.map((f) => join(logsDir, f)).filter((f) => existsSync(f));

  return { files: found, dir: logsDir };
}

async function createBundle(opts: {
  projectSlug: string | null;
  cwd: string;
  noReveal: boolean;
}): Promise<string> {
  const log = getCliLogger();
  mkdirSync(OK_BUGS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipName = `${timestamp}-bugreport.zip`;
  const zipPath = join(OK_BUGS_DIR, zipName);

  log?.info({ projectSlug: opts.projectSlug }, 'gathering diagnostic data');

  const sysinfo = collectSysinfo();
  const { files: logFiles } = collectLogs(opts.projectSlug);
  const { files: lockFiles } = collectLockDir(opts.cwd);
  const { files: localSinkFiles } = collectLocalSinkLogs(opts.cwd);

  log?.info(
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

  for (const logFile of logFiles) {
    try {
      const raw = readFileSync(logFile, 'utf8');
      const { redacted, patterns, lineCount } = redactContent(raw);
      const name = `logs/${basename(logFile)}`;
      zipfile.addBuffer(Buffer.from(redacted, 'utf8'), name);
      bundleFiles.push(name);
      if (patterns.length > 0) {
        redactions.push({ file: name, lineCount, patterns });
      }
    } catch {}
  }

  for (const lockFile of lockFiles) {
    try {
      const raw = readFileSync(lockFile, 'utf8');
      const { redacted, patterns, lineCount } = redactContent(raw);
      const name = `lockdir/${basename(lockFile)}`;
      zipfile.addBuffer(Buffer.from(redacted, 'utf8'), name);
      bundleFiles.push(name);
      if (patterns.length > 0) {
        redactions.push({ file: name, lineCount, patterns });
      }
    } catch {}
  }

  for (const localSinkFile of localSinkFiles) {
    try {
      const raw = readFileSync(localSinkFile, 'utf8');
      const { redacted, patterns, lineCount } = redactContent(raw);
      const name = `local-logs/${basename(localSinkFile)}`;
      zipfile.addBuffer(Buffer.from(redacted, 'utf8'), name);
      bundleFiles.push(name);
      if (patterns.length > 0) {
        redactions.push({ file: name, lineCount, patterns });
      }
    } catch {}
  }

  const sysinfoJson = JSON.stringify(sysinfo, null, 2);
  zipfile.addBuffer(Buffer.from(sysinfoJson, 'utf8'), 'sysinfo.json');
  bundleFiles.push('sysinfo.json');

  const manifest: BundleManifest = {
    generatedAt: new Date().toISOString(),
    disciplineVersion: '1.0.0',
    projectSlug: opts.projectSlug,
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
    `Project: ${opts.projectSlug ?? '(unscoped)'}`,
    `Discipline version: ${manifest.disciplineVersion}`,
    '',
    '## Contents',
    '',
    ...bundleFiles.map((f) => `- ${f}`),
    '',
    '## Privacy',
    '',
    'This bundle was auto-redacted before packaging.',
    `Patterns checked: ${SECRET_PATTERN_NAMES.join(', ')}`,
    totalRedacted > 0
      ? `${totalRedacted} line(s) were scrubbed across ${redactions.length} file(s).`
      : 'No redactions were needed.',
    'See MANIFEST.json for the full redaction audit report.',
    '',
    'This bundle is safe to attach to a GitHub issue.',
  ].join('\n');
  zipfile.addBuffer(Buffer.from(readme, 'utf8'), 'README.md');

  zipfile.end();
  const output = createWriteStream(zipPath);
  zipfile.outputStream.pipe(output);
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
  });

  log?.info(
    { bundlePath: zipPath, fileCount: bundleFiles.length, redactionCount: totalRedacted },
    'bundle written',
  );

  process.stdout.write(`${zipPath}\n`);

  if (totalRedacted > 0) {
    process.stderr.write(
      `ok bug-report: ${totalRedacted} line(s) auto-redacted across ${redactions.length} file(s)\n`,
    );
  }

  if (!opts.noReveal && platform() === 'darwin') {
    try {
      childSpawn('/usr/bin/open', ['-R', zipPath], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
  }

  return zipPath;
}

export function bugReportCommand(): Command {
  return new Command('bug-report')
    .description('Generate a diagnostic bundle for bug reporting')
    .option('--reveal', 'Reveal the bundle in Finder (default: true)', true)
    .option('--no-reveal', 'Do not reveal the bundle in Finder')
    .action(async (opts: { reveal: boolean }) => {
      const cwd = process.cwd();
      const projectSlug = resolveProjectSlug(cwd);

      try {
        await createBundle({
          projectSlug,
          cwd,
          noReveal: !opts.reveal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`ok bug-report: failed — ${msg}\n`);
        process.exitCode = 1;
      }
    });
}

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type BundleLogger,
  collectBugReportLedgerFiles,
  collectShipItLogFiles,
  collectStandardBundle,
  collectUserLogFiles,
  DESKTOP_BUNDLE_ID,
  defaultBugReportZipPath,
  MAX_BUNDLED_LEDGER_REPORTS,
  okBugReportsDir,
} from './bug-report-bundle.ts';

const tmpDirs: string[] = [];

function makeTmpDir(prefix = 'ok-bugreport-test-'): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function writeAt(baseDir: string, relPath: string, body: string): void {
  const full = join(baseDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function listZipEntries(zipPath: string): string[] {
  const out = execSync(`unzip -Z1 ${JSON.stringify(zipPath)}`, { encoding: 'utf-8' });
  return out.split('\n').filter(Boolean);
}

function readZipEntry(zipPath: string, entry: string): string {
  const extractDir = makeTmpDir('ok-bugreport-extract-');
  execSync(
    `unzip -q -o ${JSON.stringify(zipPath)} ${JSON.stringify(entry)} -d ${JSON.stringify(extractDir)}`,
  );
  return readFileSync(join(extractDir, entry), 'utf8');
}

function makeProjectDir(slug = 'bundle-proj'): string {
  const projectDir = makeTmpDir();
  writeAt(projectDir, '.ok/config.yml', `name: ${slug}\n`);
  return projectDir;
}

describe('collectStandardBundle — diagnostic-report staging count', () => {
  test('counts what reached the zip, not what the sweep selected', async () => {
    const projectDir = makeProjectDir();
    const reportsDir = makeTmpDir();
    const present = join(reportsDir, 'OpenKnowledge-present.ips');
    writeFileSync(
      present,
      `${JSON.stringify({ name: 'OpenKnowledge' })}\n{"procName":"OpenKnowledge"}\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      diagnosticReports: {
        files: [present, join(reportsDir, 'OpenKnowledge-vanished.ips')],
        outcome: 'collected',
        foreignIgnored: 0,
        unparseable: 0,
        droppedOverCap: 0,
        windowDays: 7,
      },
    });

    expect(listZipEntries(zipPath)).toContain('diagnostic-reports/OpenKnowledge-present.ips');
    expect(readZipEntry(zipPath, 'state/diagnostic-reports-status.txt')).toBe(
      '1 collected (7d; 0 other-process report(s) ignored; 0 unparseable; 1 vanished before staging)\n',
    );
  });
});

describe('collectStandardBundle — project bundle', () => {
  test('packages lock/spawn-error, local sink logs, and sysinfo into the zip', async () => {
    const projectDir = makeProjectDir();
    writeAt(projectDir, '.ok/local/server.lock', '{"pid":1234}\n');
    writeAt(projectDir, '.ok/local/last-spawn-error.log', 'spawn failed\n');
    writeAt(projectDir, '.ok/local/logs/server-current.jsonl', '{"level":30}\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
    });

    expect(zipPath).toBe(outputPath);
    expect(existsSync(zipPath)).toBe(true);
    expect(summary.projectSlug).toBe('bundle-proj');

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('lockdir/server.lock');
    expect(entries).toContain('lockdir/last-spawn-error.log');
    expect(entries).toContain('local-logs/server-current.jsonl');
    expect(entries).toContain('sysinfo.json');
    expect(entries).toContain('MANIFEST.json');
    expect(entries).toContain('README.md');

    const sysinfo = JSON.parse(readZipEntry(zipPath, 'sysinfo.json'));
    expect(sysinfo.hostname).toBe('[redacted]');
    expect(typeof sysinfo.platform).toBe('string');
  });

  test('last-server-crash.json is packaged from the lock dir when the server recorded a crash', async () => {
    const projectDir = makeProjectDir();
    const body = '{"origin":"uncaughtException","error":{"name":"Error","message":"boom"}}\n';
    writeAt(projectDir, '.ok/local/last-server-crash.json', body);
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('lockdir/last-server-crash.json');
    expect(readZipEntry(zipPath, 'lockdir/last-server-crash.json')).toBe(body);
  });

  test('MANIFEST.json mirrors the returned summary', async () => {
    const projectDir = makeProjectDir();
    writeAt(projectDir, '.ok/local/server.lock', '{"pid":1}\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
    });

    const manifest = JSON.parse(readZipEntry(zipPath, 'MANIFEST.json'));
    expect(manifest.projectSlug).toBe(summary.projectSlug);
    expect(manifest.files).toEqual(summary.files);
    expect(manifest.redactions).toEqual(summary.redactions);
    expect(manifest.generatedAt).toBe(summary.generatedAt);
    expect(summary.files).toContain('lockdir/server.lock');
    expect(summary.files).toContain('sysinfo.json');
  });

  test('falls back to a hashed slug when .ok exists without a config name', async () => {
    const projectDir = makeTmpDir();
    writeAt(projectDir, '.ok/local/server.lock', '{}\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { summary } = await collectStandardBundle({ projectDir, redact: true, outputPath });

    expect(summary.projectSlug).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('collectStandardBundle — redaction', () => {
  const secret = `ghp_${'a'.repeat(40)}`;

  test('scrubs a seeded secret and records the audit', async () => {
    const projectDir = makeProjectDir();
    writeAt(projectDir, '.ok/local/last-spawn-error.log', `token ${secret} leaked\n`);
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
    });

    const bundled = readZipEntry(zipPath, 'lockdir/last-spawn-error.log');
    expect(bundled).not.toContain(secret);
    expect(bundled).toContain('[REDACTED-GH-PAT]');

    expect(summary.redactedLineCount).toBeGreaterThanOrEqual(1);
    const audit = summary.redactions.find((r) => r.file === 'lockdir/last-spawn-error.log');
    expect(audit?.patterns).toContain('github-pat');

    const readme = readZipEntry(zipPath, 'README.md');
    expect(readme).toContain('line(s) were scrubbed');
  });

  test('redact: false leaves content unmodified and the audit empty', async () => {
    const projectDir = makeProjectDir();
    writeAt(projectDir, '.ok/local/last-spawn-error.log', `token ${secret} leaked\n`);
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectStandardBundle({
      projectDir,
      redact: false,
      outputPath,
    });

    const bundled = readZipEntry(zipPath, 'lockdir/last-spawn-error.log');
    expect(bundled).toContain(secret);
    expect(summary.redactions).toEqual([]);
    expect(summary.redactedLineCount).toBe(0);

    const readme = readZipEntry(zipPath, 'README.md');
    expect(readme).toContain('Redaction was disabled');
    expect(readme).not.toContain('safe to attach');
  });
});

const CLI_LOG_MATCHING_SLUG =
  '{"level":30,"time":"2026-08-05T10:00:00.000Z","pid":51000,"runtime":"cli","project":"bundle-proj","name":"cli","command":"start"}\n';
const CLI_LOG_OTHER_PROJECT =
  '{"level":30,"time":"2026-08-04T10:00:00.000Z","pid":50000,"runtime":"cli","project":"someone-else","name":"cli","command":"start"}\n';
const DESKTOP_LOG_LINE =
  '{"level":30,"time":"2026-08-05T10:00:00.000Z","pid":46323,"runtime":"desktop","name":"desktop","subsystem":"boot","event":"desktop.boot","version":"0.48.7"}\n';
const MCP_MIRROR_LINE = '2026-08-05T10:00:00.000Z [mcp] stdio server ready\n';
const DESKTOP_LOG_WITH_FOREIGN_SLUG_IN_CONSOLE = `${DESKTOP_LOG_LINE}{"level":30,"time":"2026-08-05T10:00:01.000Z","pid":46323,"runtime":"desktop","name":"desktop","subsystem":"renderer","event":"renderer.console","args":[{"project":"someone-else"}]}\n`;

describe('collectStandardBundle — user-level logs', () => {
  test('includes .log and rotated .log.N files, skipping other extensions', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'desktop.log'), 'line\n');
    writeFileSync(join(userLogsDir, 'desktop.log.1'), 'rotated\n');
    writeFileSync(join(userLogsDir, 'notes.txt'), 'not a log\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({ redact: true, outputPath, userLogsDir });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/desktop.log');
    expect(entries).toContain('logs/desktop.log.1');
    expect(entries).not.toContain('logs/notes.txt');
  });

  test('narrows user logs to those mentioning the project slug when any match', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), '{"project":"bundle-proj"}\n');
    writeFileSync(join(userLogsDir, 'cli.2026-08-04.log'), '{"project":"someone-else"}\n');
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/cli.2026-08-05.log');
    expect(entries).not.toContain('logs/cli.2026-08-04.log');
  });

  test('keeps every user log when none mention the project slug', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), 'no slug here\n');
    writeFileSync(join(userLogsDir, 'cli.2026-08-04.log'), 'none here either\n');
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/cli.2026-08-05.log');
    expect(entries).toContain('logs/cli.2026-08-04.log');
  });

  test('keeps log families that cannot carry a project slug when another log matches', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), CLI_LOG_MATCHING_SLUG);
    writeFileSync(join(userLogsDir, 'desktop.2026-08-05.log'), DESKTOP_LOG_LINE);
    writeFileSync(join(userLogsDir, 'mcp.2026-08-05.log'), MCP_MIRROR_LINE);
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/cli.2026-08-05.log');
    expect(entries).toContain('logs/desktop.2026-08-05.log');
    expect(entries).toContain('logs/mcp.2026-08-05.log');

    const manifest = JSON.parse(readZipEntry(zipPath, 'MANIFEST.json'));
    expect(manifest.files).toEqual(summary.files);
    expect(manifest.files).toContain('logs/desktop.2026-08-05.log');
    expect(manifest.files).toContain('logs/mcp.2026-08-05.log');
  });

  test('still excludes a project-taggable log belonging to another project', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), CLI_LOG_MATCHING_SLUG);
    writeFileSync(join(userLogsDir, 'cli.2026-08-04.log'), CLI_LOG_OTHER_PROJECT);
    writeFileSync(join(userLogsDir, 'desktop.2026-08-05.log'), DESKTOP_LOG_LINE);
    writeFileSync(join(userLogsDir, 'mcp.2026-08-05.log'), MCP_MIRROR_LINE);
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/cli.2026-08-05.log');
    expect(entries).toContain('logs/desktop.2026-08-05.log');
    expect(entries).toContain('logs/mcp.2026-08-05.log');
    expect(entries).not.toContain('logs/cli.2026-08-04.log');
  });

  test('keeps a desktop log whose captured console mentions another project', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), CLI_LOG_MATCHING_SLUG);
    writeFileSync(
      join(userLogsDir, 'desktop.2026-08-05.log'),
      DESKTOP_LOG_WITH_FOREIGN_SLUG_IN_CONSOLE,
    );
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/cli.2026-08-05.log');
    expect(entries).toContain('logs/desktop.2026-08-05.log');
  });

  test('keeps a log family the collector does not recognize', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), CLI_LOG_MATCHING_SLUG);
    writeFileSync(join(userLogsDir, 'cli.2026-08-04.log'), CLI_LOG_OTHER_PROJECT);
    writeFileSync(
      join(userLogsDir, 'future-writer.2026-08-05.log'),
      'a writer nobody listed yet\n',
    );
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/future-writer.2026-08-05.log');
    expect(entries).toContain('logs/cli.2026-08-05.log');
    expect(entries).not.toContain('logs/cli.2026-08-04.log');
  });

  test('narrows rotated CLI logs too', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), CLI_LOG_MATCHING_SLUG);
    writeFileSync(join(userLogsDir, 'cli.2026-08-04.log.1'), CLI_LOG_OTHER_PROJECT);
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/cli.2026-08-05.log');
    expect(entries).not.toContain('logs/cli.2026-08-04.log.1');
  });

  test('an unreadable taggable entry does not drop its siblings', async () => {
    const userLogsDir = makeTmpDir();
    mkdirSync(join(userLogsDir, 'cli.2026-08-04.log'));
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), CLI_LOG_MATCHING_SLUG);
    writeFileSync(join(userLogsDir, 'desktop.2026-08-05.log'), DESKTOP_LOG_LINE);
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    expect(existsSync(zipPath)).toBe(true);
    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/cli.2026-08-05.log');
    expect(entries).toContain('logs/desktop.2026-08-05.log');
    expect(entries).not.toContain('logs/cli.2026-08-04.log');
  });

  test('an unreadable taggable entry does not suppress the keep-all fallback', async () => {
    const userLogsDir = makeTmpDir();
    mkdirSync(join(userLogsDir, 'cli.2026-08-03.log'));
    writeFileSync(join(userLogsDir, 'cli.2026-08-04.log'), CLI_LOG_OTHER_PROJECT);
    writeFileSync(join(userLogsDir, 'desktop.2026-08-05.log'), DESKTOP_LOG_LINE);
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/cli.2026-08-04.log');
    expect(entries).toContain('logs/desktop.2026-08-05.log');
  });
});

describe('collectUserLogFiles — shared collector', () => {
  test('keeps log families that cannot carry a project slug', () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), CLI_LOG_MATCHING_SLUG);
    writeFileSync(join(userLogsDir, 'desktop.2026-08-05.log'), DESKTOP_LOG_LINE);
    writeFileSync(join(userLogsDir, 'mcp.2026-08-05.log'), MCP_MIRROR_LINE);

    const names = collectUserLogFiles('bundle-proj', userLogsDir)
      .map((f) => basename(f))
      .sort();

    expect(names).toEqual(['cli.2026-08-05.log', 'desktop.2026-08-05.log', 'mcp.2026-08-05.log']);
  });

  test('still narrows the taggable family to the requested project', () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), CLI_LOG_MATCHING_SLUG);
    writeFileSync(join(userLogsDir, 'cli.2026-08-04.log'), CLI_LOG_OTHER_PROJECT);
    writeFileSync(join(userLogsDir, 'desktop.2026-08-05.log'), DESKTOP_LOG_LINE);

    const names = collectUserLogFiles('bundle-proj', userLogsDir)
      .map((f) => basename(f))
      .sort();

    expect(names).toEqual(['cli.2026-08-05.log', 'desktop.2026-08-05.log']);
  });
});

describe('collectShipItLogFiles — Squirrel.Mac install logs', () => {
  test('collects the desktop app ShipIt logs', () => {
    const cachesDir = makeTmpDir();
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stderr.log`, 'Installation failed\n');
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stdout.log`, '');

    const names = collectShipItLogFiles(cachesDir)
      .map((f) => basename(f))
      .sort();

    expect(names).toEqual(['ShipIt_stderr.log', 'ShipIt_stdout.log']);
  });

  test('never harvests another application ShipIt logs', () => {
    const cachesDir = makeTmpDir();
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stderr.log`, 'ours\n');
    writeAt(cachesDir, 'com.tinyspeck.slackmacgap.ShipIt/ShipIt_stderr.log', 'theirs\n');
    writeAt(cachesDir, 'com.anthropic.claudefordesktop.ShipIt/ShipIt_stderr.log', 'theirs\n');

    const bodies = collectShipItLogFiles(cachesDir).map((f) => readFileSync(f, 'utf8'));

    expect(bodies).toEqual(['ours\n']);
  });

  test('ignores sub-bundle ShipIt directories that would collide when staged', () => {
    const cachesDir = makeTmpDir();
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stderr.log`, 'app\n');
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.server.ShipIt/ShipIt_stderr.log`, 'server\n');

    const bodies = collectShipItLogFiles(cachesDir).map((f) => readFileSync(f, 'utf8'));

    expect(bodies).toEqual(['app\n']);
  });

  test('returns empty when the caches directory does not exist', () => {
    expect(collectShipItLogFiles(join(makeTmpDir(), 'absent'))).toEqual([]);
  });

  test('collects the numeric-suffixed logs Squirrel falls back to', () => {
    const cachesDir = makeTmpDir();
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stderr.log`, 'stale root-owned\n');
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stderr.log.1`, 'the live run\n');
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stdout.log.2`, 'stdout fallback\n');

    const names = collectShipItLogFiles(cachesDir)
      .map((f) => basename(f))
      .sort();

    expect(names).toEqual(['ShipIt_stderr.log', 'ShipIt_stderr.log.1', 'ShipIt_stdout.log.2']);
  });

  test('ignores neighbours that merely start with a ShipIt log name', () => {
    const cachesDir = makeTmpDir();
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stderr.log.1`, 'ours\n');
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stderr.log.bak`, 'theirs\n');
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipItState.plist`, 'theirs\n');
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stderr.logging`, 'theirs\n');

    const bodies = collectShipItLogFiles(cachesDir).map((f) => readFileSync(f, 'utf8'));

    expect(bodies).toEqual(['ours\n']);
  });

  test('bounds how many fallback logs one stream contributes', () => {
    const cachesDir = makeTmpDir();
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stderr.log`, 'base\n');
    for (let i = 1; i <= 12; i++) {
      writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stderr.log.${i}`, `n${i}\n`);
    }

    const names = collectShipItLogFiles(cachesDir).map((f) => basename(f));

    expect(names).toEqual([
      'ShipIt_stderr.log',
      'ShipIt_stderr.log.1',
      'ShipIt_stderr.log.2',
      'ShipIt_stderr.log.3',
    ]);
  });

  test('stages the ShipIt log into the bundle under logs/', async () => {
    const userLogsDir = makeTmpDir();
    const cachesDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'desktop.2026-08-05.log'), DESKTOP_LOG_LINE);
    writeAt(
      cachesDir,
      `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stderr.log`,
      'ShipIt[1:2] Installation completed successfully\n',
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir: makeProjectDir('bundle-proj'),
      redact: true,
      outputPath,
      userLogsDir,
      shipItLogFiles: collectShipItLogFiles(cachesDir),
    });

    expect(listZipEntries(zipPath)).toContain('logs/ShipIt_stderr.log');
  });

  test('discloses the ShipIt log in its own paragraph, not the daily user-wide list', async () => {
    const userLogsDir = makeTmpDir();
    const cachesDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), CLI_LOG_MATCHING_SLUG);
    writeFileSync(join(userLogsDir, 'desktop.2026-08-05.log'), DESKTOP_LOG_LINE);
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stderr.log`, 'swap\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir: makeProjectDir('bundle-proj'),
      redact: true,
      outputPath,
      userLogsDir,
      shipItLogFiles: collectShipItLogFiles(cachesDir),
    });

    const readme = readZipEntry(zipPath, 'README.md');
    const privacy = readme.slice(readme.indexOf('## Privacy'));
    const scopeNote = privacy.slice(
      privacy.indexOf('Scope: some collected logs'),
      privacy.indexOf('Installer logs:'),
    );
    expect(scopeNote).toContain('- logs/desktop.2026-08-05.log');
    expect(scopeNote).not.toContain('ShipIt');

    expect(privacy).toContain('macOS update helper');
    expect(privacy.match(/^- logs\/ShipIt_stderr\.log$/gm)).toHaveLength(1);
  });

  test('discloses the installer log in an unscoped bundle too', async () => {
    const cachesDir = makeTmpDir();
    writeAt(cachesDir, `${DESKTOP_BUNDLE_ID}.ShipIt/ShipIt_stderr.log`, 'swap\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      shipItLogFiles: collectShipItLogFiles(cachesDir),
    });

    const readme = readZipEntry(zipPath, 'README.md');
    expect(readme).toContain('Project: (unscoped)');
    expect(readme).toContain('macOS update helper');
    expect(readme).toContain('- logs/ShipIt_stderr.log');
  });

  test('omits the installer disclosure when no ShipIt log was collected', async () => {
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir: makeProjectDir('bundle-proj'),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      shipItLogFiles: collectShipItLogFiles(join(makeTmpDir(), 'absent')),
    });

    expect(readZipEntry(zipPath, 'README.md')).not.toContain('macOS update helper');
  });
});

describe('collectStandardBundle — narrowing diagnostics', () => {
  test('counts only the taggable logs the slug ruled out', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), CLI_LOG_MATCHING_SLUG);
    writeFileSync(join(userLogsDir, 'cli.2026-08-04.log'), CLI_LOG_OTHER_PROJECT);
    writeFileSync(join(userLogsDir, 'cli.2026-08-03.log.1'), CLI_LOG_OTHER_PROJECT);
    writeFileSync(join(userLogsDir, 'desktop.2026-08-05.log'), DESKTOP_LOG_LINE);
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const infoPayloads: Record<string, unknown>[] = [];
    const logger: BundleLogger = {
      info: (payload) => {
        infoPayloads.push(payload);
      },
      warn: () => {},
    };

    await collectStandardBundle({ projectDir, redact: true, outputPath, userLogsDir, logger });

    const collected = infoPayloads.find((p) => 'logFilesExcludedByProjectSlug' in p);
    expect(collected?.logFilesExcludedByProjectSlug).toBe(2);
    expect(collected?.logFileCount).toBe(2);
  });
});

describe('collectStandardBundle — bundle scope disclosure', () => {
  test('names the retained user-wide log families in a project-scoped bundle', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), CLI_LOG_MATCHING_SLUG);
    writeFileSync(join(userLogsDir, 'desktop.2026-08-05.log'), DESKTOP_LOG_LINE);
    writeFileSync(join(userLogsDir, 'mcp.2026-08-05.log'), MCP_MIRROR_LINE);
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const readme = readZipEntry(zipPath, 'README.md');
    expect(readme).toContain('user-wide rather than project-scoped');

    const scopeNote = readme.slice(readme.indexOf('Scope: some collected logs'));
    const listed = scopeNote
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2))
      .sort();
    expect(listed).toEqual(['logs/desktop.2026-08-05.log', 'logs/mcp.2026-08-05.log']);
  });

  test('omits the scope note when only project-taggable logs were collected', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'cli.2026-08-05.log'), CLI_LOG_MATCHING_SLUG);
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const readme = readZipEntry(zipPath, 'README.md');
    expect(readme).not.toContain('user-wide rather than project-scoped');
  });

  test('discloses the send ledger as machine-wide, naming its entries', async () => {
    const reportsDir = makeTmpDir('ok-bugreport-ledger-');
    writeFileSync(
      join(reportsDir, '2026-08-19T16-42-03-547Z-bugreport.yaml'),
      'id: 2026-08-19T16-42-03-547Z-bugreport.zip\nprojectSlug: someotherproject\n',
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir: makeProjectDir('bundle-proj'),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      bugReportLedgerFiles: collectBugReportLedgerFiles(reportsDir),
    });

    const readme = readZipEntry(zipPath, 'README.md');
    const privacy = readme.slice(readme.indexOf('## Privacy'));
    expect(privacy).toContain('Send history:');
    expect(privacy).toContain('names the other projects reports were filed');
    expect(
      privacy.match(/^- state\/bug-reports\/2026-08-19T16-42-03-547Z-bugreport\.yaml$/gm),
    ).toHaveLength(1);
  });

  test('discloses the send ledger in an unscoped bundle too', async () => {
    const reportsDir = makeTmpDir('ok-bugreport-ledger-');
    writeFileSync(
      join(reportsDir, '2026-08-19T16-42-03-547Z-bugreport.yaml'),
      'id: 2026-08-19T16-42-03-547Z-bugreport.zip\nprojectSlug: null\n',
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      bugReportLedgerFiles: collectBugReportLedgerFiles(reportsDir),
    });

    const readme = readZipEntry(zipPath, 'README.md');
    const privacy = readme.slice(readme.indexOf('## Privacy'));
    expect(privacy).not.toContain('user-wide rather than project-scoped');
    expect(privacy).toContain('Send history:');
  });

  test('does not disclose a sidecar that failed to stage', async () => {
    const reportsDir = makeTmpDir('ok-bugreport-ledger-');
    const ghost = join(reportsDir, '2026-08-19T16-42-03-547Z-bugreport.yaml');
    writeFileSync(ghost, 'id: x\n');
    const listed = collectBugReportLedgerFiles(reportsDir);
    rmSync(ghost);
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir: makeProjectDir('bundle-proj'),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      bugReportLedgerFiles: listed,
    });

    const readme = readZipEntry(zipPath, 'README.md');
    expect(readme.slice(readme.indexOf('## Privacy'))).not.toContain('Send history:');
    expect(listZipEntries(zipPath).filter((e) => e.startsWith('state/bug-reports/'))).toEqual([]);
  });

  test('stages a sent marker alongside the sidecar it stands in for', async () => {
    const reportsDir = makeTmpDir('ok-bugreport-ledger-');
    const base = '2026-08-19T16-42-03-547Z-bugreport';
    writeFileSync(join(reportsDir, `${base}.yaml`), 'id: [unreadable\n  : :');
    writeFileSync(
      join(reportsDir, `${base}.sent.yaml`),
      `version: 1\nid: ${base}.zip\nsentAt: 2026-08-19T16:45:00.000Z\nreference: OK-4821\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir: makeProjectDir('bundle-proj'),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      bugReportLedgerFiles: collectBugReportLedgerFiles(reportsDir),
    });

    const staged = listZipEntries(zipPath).filter((e) => e.startsWith('state/bug-reports/'));
    expect(staged).toContain(`state/bug-reports/${base}.sent.yaml`);
    expect(staged).toContain(`state/bug-reports/${base}.yaml`);
    expect(readZipEntry(zipPath, `state/bug-reports/${base}.sent.yaml`)).toContain('OK-4821');
  });

  test('the ledger cap evicts whole reports, never half of a marker pair', () => {
    const reportsDir = makeTmpDir('ok-bugreport-ledger-');
    const bases: string[] = [];
    for (let i = 1; i <= MAX_BUNDLED_LEDGER_REPORTS + 2; i += 1) {
      const base = `2026-08-19T16-42-${String(i).padStart(2, '0')}-000Z-bugreport`;
      bases.push(base);
      writeFileSync(join(reportsDir, `${base}.yaml`), `id: ${base}.zip\n`);
      writeFileSync(join(reportsDir, `${base}.sent.yaml`), `id: ${base}.zip\nreference: OK-${i}\n`);
    }

    const listed = collectBugReportLedgerFiles(reportsDir).map((p) => basename(p));

    for (const base of bases) {
      expect(listed.includes(`${base}.sent.yaml`)).toBe(listed.includes(`${base}.yaml`));
    }
    expect(listed).toHaveLength(MAX_BUNDLED_LEDGER_REPORTS * 2);
    expect(listed).not.toContain(`${nthBase(bases, 0)}.yaml`);
    expect(listed).toContain(`${nthBase(bases, -1)}.yaml`);
  });
});

function nthBase(bases: readonly string[], index: number): string {
  const value = bases.at(index);
  if (value === undefined) throw new Error(`no base at index ${index}`);
  return value;
}

describe('collectStandardBundle — system-wide (no projectDir)', () => {
  test('captures user logs + sysinfo only, with a null slug', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'desktop.log'), 'line\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectStandardBundle({
      redact: true,
      outputPath,
      userLogsDir,
    });

    expect(summary.projectSlug).toBeNull();
    const entries = listZipEntries(zipPath);
    expect(entries).toEqual(
      expect.arrayContaining(['logs/desktop.log', 'sysinfo.json', 'MANIFEST.json', 'README.md']),
    );
    expect(entries.some((e) => e.startsWith('lockdir/'))).toBe(false);
    expect(entries.some((e) => e.startsWith('local-logs/'))).toBe(false);

    const readme = readZipEntry(zipPath, 'README.md');
    expect(readme).toContain('Project: (unscoped)');

    expect(readme).not.toContain('user-wide rather than project-scoped');
  });
});

describe('defaultBugReportZipPath', () => {
  test('derives ~/.ok/bug-reports/<timestamp>-bugreport.zip with : and . replaced', () => {
    const path = defaultBugReportZipPath(new Date('2026-07-10T01:02:03.456Z'));
    expect(path).toBe(
      join(homedir(), '.ok', 'bug-reports', '2026-07-10T01-02-03-456Z-bugreport.zip'),
    );
    expect(okBugReportsDir()).toBe(join(homedir(), '.ok', 'bug-reports'));
  });
});

describe('collectStandardBundle — document names are a Detailed-diagnostics field', () => {
  const scrollLog = [
    '{"level":30,"msg":"ok-outline-nav-dispatch","docName":"notes/salary-negotiation.md","index":3}',
    '{"level":30,"msg":"ok-scroll-restore","docName":"notes/salary-negotiation.md","top":120}',
    '{"level":30,"msg":"ok-outline-nav","docName":"private/board-deck.md","index":0}',
  ].join('\n');

  test('replaces every docName with a digest that still groups one document', async () => {
    const userLogsDir = makeTmpDir();
    writeAt(userLogsDir, 'desktop.2026-08-27.log', `${scrollLog}\n`);
    const outputPath = join(makeTmpDir(), 'report.zip');

    await collectStandardBundle({ redact: true, outputPath, userLogsDir });

    const staged = readZipEntry(outputPath, 'logs/desktop.2026-08-27.log');

    expect(staged).not.toContain('salary-negotiation');
    expect(staged).not.toContain('board-deck');
    expect(staged).not.toContain('notes/');
    expect(staged).not.toContain('private/');

    const records = staged
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { msg: string; docName: string; index?: number; top?: number },
      );
    expect(records).toHaveLength(3);
    expect(records.every((r) => /^doc#[0-9a-f]{12}$/.test(r.docName))).toBe(true);

    expect(records[0].docName).toBe(records[1].docName);
    expect(records[0].docName).not.toBe(records[2].docName);

    expect(records[0].index).toBe(3);
    expect(records[1].top).toBe(120);
  });

  test('holds when the caller turns the secret scrub off — this is a tier rule, not a redaction rule', async () => {
    const userLogsDir = makeTmpDir();
    writeAt(userLogsDir, 'desktop.2026-08-27.log', `${scrollLog}\n`);
    const outputPath = join(makeTmpDir(), 'report.zip');

    await collectStandardBundle({ redact: false, outputPath, userLogsDir });

    const staged = readZipEntry(outputPath, 'logs/desktop.2026-08-27.log');
    expect(staged).not.toContain('salary-negotiation');
    expect(staged).toContain('doc#');
  });

  test('a name carrying an escaped quote is replaced whole, not up to the escape', async () => {
    const userLogsDir = makeTmpDir();
    writeAt(
      userLogsDir,
      'desktop.2026-08-27.log',
      '{"level":30,"msg":"ok-scroll-restore","docName":"notes/she said \\"hi\\".md","top":9}\n',
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    await collectStandardBundle({ redact: true, outputPath, userLogsDir });

    const staged = readZipEntry(outputPath, 'logs/desktop.2026-08-27.log');
    expect(staged).not.toContain('she said');
    const record = JSON.parse(staged.trim()) as { docName: string; top: number };
    expect(record.docName).toMatch(/^doc#[0-9a-f]{12}$/);
    expect(record.top).toBe(9);
  });
  test('revealDocNames ships the names as written — the Detailed-diagnostics tier', async () => {
    const userLogsDir = makeTmpDir();
    writeAt(userLogsDir, 'desktop.2026-08-27.log', `${scrollLog}\n`);
    const outputPath = join(makeTmpDir(), 'report.zip');

    await collectStandardBundle({ redact: true, outputPath, userLogsDir, revealDocNames: true });

    const staged = readZipEntry(outputPath, 'logs/desktop.2026-08-27.log');
    expect(staged).toContain('notes/salary-negotiation.md');
    expect(staged).not.toContain('doc#');
  });
  test('masks the same name where it is interpolated into a message body', async () => {
    const userLogsDir = makeTmpDir();
    writeAt(
      userLogsDir,
      'desktop.2026-08-27.log',
      `${[
        '{"level":30,"msg":"ok-scroll-restore","docName":"notes/salary-negotiation.md","top":1}',
        '{"level":30,"msg":"[syncPromise] notes/salary-negotiation.md resolved synchronously (warm provider)"}',
      ].join('\n')}\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    await collectStandardBundle({ redact: true, outputPath, userLogsDir });

    const staged = readZipEntry(outputPath, 'logs/desktop.2026-08-27.log');
    expect(staged).not.toContain('salary-negotiation');
    const records = staged
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { msg: string; docName?: string });
    const digest = records[0].docName as string;
    expect(digest).toMatch(/^doc#[0-9a-f]{12}$/);
    expect(records[1].msg).toBe(`[syncPromise] ${digest} resolved synchronously (warm provider)`);
  });

  test('masks documentName, which does not contain the literal docName', async () => {
    const userLogsDir = makeTmpDir();
    writeAt(
      userLogsDir,
      'desktop.2026-08-27.log',
      '{"level":50,"documentName":"private/board-deck.md","msg":"[persistence] Failed to save private/board-deck.md"}\n',
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    await collectStandardBundle({ redact: true, outputPath, userLogsDir });

    const staged = readZipEntry(outputPath, 'logs/desktop.2026-08-27.log');
    expect(staged).not.toContain('board-deck');
    const record = JSON.parse(staged.trim()) as { documentName: string; msg: string };
    expect(record.documentName).toMatch(/^doc#[0-9a-f]{12}$/);
    expect(record.msg).toBe(`[persistence] Failed to save ${record.documentName}`);
  });

  test('a name that is a prefix of another does not corrupt the longer one', async () => {
    const userLogsDir = makeTmpDir();
    writeAt(
      userLogsDir,
      'desktop.2026-08-27.log',
      `${[
        '{"level":30,"docName":"notes/plan","msg":"opened notes/plan"}',
        '{"level":30,"docName":"notes/plan-b","msg":"opened notes/plan-b"}',
      ].join('\n')}\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    await collectStandardBundle({ redact: true, outputPath, userLogsDir });

    const staged = readZipEntry(outputPath, 'logs/desktop.2026-08-27.log');
    expect(staged).not.toContain('notes/plan');
    expect(staged).not.toContain('-b"');
    const records = staged
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { docName: string; msg: string });
    expect(records[0].docName).not.toBe(records[1].docName);
    expect(records[1].msg).toBe(`opened ${records[1].docName}`);
  });
});

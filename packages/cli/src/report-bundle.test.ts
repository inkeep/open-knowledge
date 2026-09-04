import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SERVER_CRASH_LOG } from '@inkeep/open-knowledge-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { collectReportBundle as collectReportBundleFromIndex } from './index.ts';
import { collectReportBundle } from './report-bundle.ts';
import type { LanguageMetadata } from './report-language.ts';

const tmpDirs: string[] = [];

function makeTmpDir(prefix = 'ok-report-test-'): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const realHome = process.env.HOME;
beforeAll(() => {
  process.env.HOME = mkdtempSync(resolve(tmpdir(), 'ok-report-test-home-'));
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function writeAt(baseDir: string, relPath: string, body: string | Buffer): void {
  const full = join(baseDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function listZipEntries(zipPath: string): string[] {
  const out = execSync(`unzip -Z1 ${JSON.stringify(zipPath)}`, { encoding: 'utf-8' });
  return out.split('\n').filter(Boolean);
}

function readZipEntry(zipPath: string, entry: string): string {
  return readZipEntryBuffer(zipPath, entry).toString('utf-8');
}

function readZipEntryBuffer(zipPath: string, entry: string): Buffer {
  const extractDir = makeTmpDir('ok-report-extract-');
  execSync(
    `unzip -q -o ${JSON.stringify(zipPath)} ${JSON.stringify(entry)} -d ${JSON.stringify(extractDir)}`,
  );
  return readFileSync(join(extractDir, entry));
}

const SECRET = `ghp_${'a'.repeat(40)}`;

function makeStandardProjectDir(slug = 'report-proj'): string {
  const projectDir = makeTmpDir();
  writeAt(projectDir, '.ok/config.yml', `name: ${slug}\n`);
  writeAt(projectDir, '.ok/local/server.lock', '{"pid":1234}\n');
  writeAt(projectDir, '.ok/local/last-spawn-error.log', 'spawn failed\n');
  writeAt(projectDir, '.ok/local/logs/server-current.jsonl', '{"level":30}\n');
  return projectDir;
}

function makeFullProjectDir(slug = 'full-proj'): string {
  const projectDir = makeTmpDir();
  writeAt(projectDir, '.ok/config.yml', `name: ${slug}\n`);
  const span = JSON.stringify({
    name: 'doc.write',
    attributes: [{ key: 'doc.name', value: { stringValue: 'secret-notes/plan' } }],
  });
  const leak = JSON.stringify({ msg: `token ${SECRET}` });
  writeAt(projectDir, '.ok/local/telemetry/spans-current.jsonl', `${span}\n${leak}\n`);
  writeAt(projectDir, '.ok/local/logs/server-current.jsonl', '{"level":30,"msg":"boot"}\n');
  return projectDir;
}

const STANDARD_PLANTS = {
  'logs/desktop.log': 'AKIAIOSFODNN7EXAMPLE',
  'local-logs/server-current.jsonl': SECRET,
  'lockdir/last-spawn-error.log': 'abcdefghijklmnopqrstuvwxyz0123456789',
  'lockdir/server.lock': 'hunter2',
  [`lockdir/${SERVER_CRASH_LOG}`]: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
  'note.txt': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.s5x8Qk3rTvW2pLmNq7Yz',
} as const satisfies Record<string, string>;

const PLANTED_NOTE = `it died right after I pasted ${STANDARD_PLANTS['note.txt']}`;

function makePlantedStandardProject(): { projectDir: string; userLogsDir: string } {
  const projectDir = makeTmpDir();
  const userLogsDir = makeTmpDir();
  writeAt(projectDir, '.ok/config.yml', 'name: planted-proj\n');
  writeAt(
    userLogsDir,
    'desktop.log',
    `{"level":50,"msg":"assume-role ${STANDARD_PLANTS['logs/desktop.log']} denied"}\n`,
  );
  writeAt(
    projectDir,
    '.ok/local/logs/server-current.jsonl',
    `{"level":50,"source":"renderer-console","msg":"push failed ${STANDARD_PLANTS['local-logs/server-current.jsonl']}"}\n`,
  );
  writeAt(
    projectDir,
    '.ok/local/last-spawn-error.log',
    `spawn failed: Authorization: Bearer ${STANDARD_PLANTS['lockdir/last-spawn-error.log']}\n`,
  );
  writeAt(
    projectDir,
    '.ok/local/server.lock',
    `{"pid":1234,"remote":"https://ci:${STANDARD_PLANTS['lockdir/server.lock']}@github.com/o/r.git"}\n`,
  );
  writeAt(
    projectDir,
    `.ok/local/${SERVER_CRASH_LOG}`,
    `{"reason":"boot failed","env":"ANTHROPIC_API_KEY=${STANDARD_PLANTS[`lockdir/${SERVER_CRASH_LOG}`]}"}\n`,
  );
  return { projectDir, userLogsDir };
}

describe('collectReportBundle — standard level', () => {
  test('packages the bug-report content set with level metadata in the summary', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
    });

    expect(zipPath).toBe(outputPath);
    expect(existsSync(zipPath)).toBe(true);
    const entries = listZipEntries(zipPath);
    expect(entries).toContain('lockdir/server.lock');
    expect(entries).toContain('lockdir/last-spawn-error.log');
    expect(entries).toContain('local-logs/server-current.jsonl');
    expect(entries).toContain('sysinfo.json');
    expect(entries).toContain('MANIFEST.json');
    expect(summary.level).toBe('standard');
    expect(summary.systemWide).toBe(false);
    expect(summary.projectSlug).toBe('report-proj');
    expect(summary.files).toContain('lockdir/server.lock');
  });

  test('persists the note as note.txt, scrubbed and audited when redact is on', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      projectDir,
      note: `crashed right after I pasted ${SECRET}`,
      redact: true,
      outputPath,
    });

    const note = readZipEntry(zipPath, 'note.txt');
    expect(note).not.toContain(SECRET);
    expect(note).toContain('[REDACTED-GH-PAT]');
    const manifest = JSON.parse(readZipEntry(zipPath, 'MANIFEST.json'));
    expect(manifest.files).toContain('note.txt');
    expect(summary.files).toContain('note.txt');
    const audit = summary.redactions.find((r) => r.file === 'note.txt');
    expect(audit?.patterns).toContain('github-pat');
    expect(summary.redactedLineCount).toBeGreaterThanOrEqual(1);
  });

  test('includes extra files byte-for-byte under extra/, never scrubbed', async () => {
    const projectDir = makeStandardProjectDir();
    const sourceDir = makeTmpDir();
    const minidump = Buffer.concat([
      Buffer.from([0x4d, 0x44, 0x4d, 0x50, 0x00, 0xff, 0xfe]),
      Buffer.from(SECRET),
      Buffer.from([0x00, 0x01, 0x02]),
    ]);
    writeAt(sourceDir, 'crash.dmp', minidump);
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
      extraFiles: [{ sourcePath: join(sourceDir, 'crash.dmp') }],
    });

    const bundled = readZipEntryBuffer(zipPath, 'extra/crash.dmp');
    expect(bundled.equals(minidump)).toBe(true);
    expect(summary.files).toContain('extra/crash.dmp');
  });

  test('canary: no planted credential survives in any standard-tier bundle artifact', async () => {
    const { projectDir, userLogsDir } = makePlantedStandardProject();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      projectDir,
      note: PLANTED_NOTE,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    for (const entry of Object.keys(STANDARD_PLANTS)) expect(entries).toContain(entry);

    const textEntries = entries.filter((e) => /\.(jsonl?|txt|log|lock|md)$/.test(e));
    for (const entry of textEntries) {
      const content = readZipEntry(zipPath, entry);
      for (const secret of Object.values(STANDARD_PLANTS)) {
        expect(`${entry}: ${content}`).not.toContain(secret);
      }
    }
    expect(summary.redactedLineCount).toBeGreaterThanOrEqual(Object.keys(STANDARD_PLANTS).length);
  });

  test('canary control: with the scrub off every planted credential lands verbatim', async () => {
    const { projectDir, userLogsDir } = makePlantedStandardProject();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'standard',
      projectDir,
      note: PLANTED_NOTE,
      redact: false,
      outputPath,
      userLogsDir,
    });

    for (const [entry, secret] of Object.entries(STANDARD_PLANTS)) {
      expect(readZipEntry(zipPath, entry)).toContain(secret);
    }
  });

  test('produces a system-wide bundle when projectDir is omitted', async () => {
    const userLogsDir = makeTmpDir();
    writeAt(userLogsDir, 'cli.log', 'started\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/cli.log');
    expect(entries).toContain('sysinfo.json');
    expect(entries.some((e) => e.startsWith('lockdir/'))).toBe(false);
    expect(summary.systemWide).toBe(true);
    expect(summary.projectSlug).toBeNull();
  });

  test('resolves the ShipIt install log from the caches dir and stages it under logs/', async () => {
    const cachesDir = makeTmpDir();
    writeAt(
      cachesDir,
      'com.inkeep.open-knowledge.ShipIt/ShipIt_stderr.log',
      'ShipIt: Failed to move bundle\n',
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      projectDir: makeStandardProjectDir(),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      cachesDir,
    });

    expect(listZipEntries(zipPath)).toContain('logs/ShipIt_stderr.log');
    expect(summary.files).toContain('logs/ShipIt_stderr.log');
    expect(readZipEntry(zipPath, 'logs/ShipIt_stderr.log')).toContain('Failed to move bundle');
  });
});

describe('collectReportBundle — full level', () => {
  test('produces the diagnose superset and omits unavailable pieces without error', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('manifest.json');
    expect(entries).toContain('telemetry/spans-current.jsonl');
    expect(entries).toContain('logs/server-current.jsonl');
    expect(entries).toContain('state/runtime.json');
    expect(entries).toContain('state/server-status.txt');
    expect(entries).not.toContain('state/shadow-head.txt');
    expect(entries).not.toContain('state/server.lock');
    expect(entries).not.toContain('state/agent-presence.json');
    const manifest = JSON.parse(readZipEntry(zipPath, 'manifest.json'));
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.serverStatus).toBe('not-running');
    const paths = manifest.files.map((f: { path: string }) => f.path);
    expect(paths).not.toContain('state/shadow-head.txt');
    expect(summary.level).toBe('full');
    expect(summary.systemWide).toBe(false);
    expect(summary.projectSlug).toBe('full-proj');
    expect(summary.files).toEqual(paths);
  });

  test('carries the user-level logs the standard level collects, scrubbed', async () => {
    const projectDir = makeFullProjectDir();
    const userLogsDir = makeTmpDir();
    writeAt(
      userLogsDir,
      'desktop.2026-07-28.log',
      `${JSON.stringify({ subsystem: 'renderer', msg: 'app-shell render crash' })}\n${JSON.stringify({ msg: `token ${SECRET}` })}\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/desktop.2026-07-28.log');
    expect(summary.files).toContain('logs/desktop.2026-07-28.log');
    const body = readZipEntry(zipPath, 'logs/desktop.2026-07-28.log');
    expect(body).toContain('app-shell render crash');
    expect(body).not.toContain(SECRET);
  });

  test('carries the ShipIt install log the standard level collects', async () => {
    const cachesDir = makeTmpDir();
    writeAt(
      cachesDir,
      'com.inkeep.open-knowledge.ShipIt/ShipIt_stderr.log',
      `ShipIt: Failed to move bundle\ntoken ${SECRET}\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir: makeFullProjectDir(),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      cachesDir,
    });

    expect(listZipEntries(zipPath)).toContain('logs/ShipIt_stderr.log');
    const shipIt = readZipEntry(zipPath, 'logs/ShipIt_stderr.log');
    expect(shipIt).toContain('Failed to move bundle');
    expect(shipIt).not.toContain(SECRET);
  });

  describe('macOS diagnostic reports', () => {
    const DEVICE_KEY = '03BEA1C8-0E42-2631-A65B-FB48F8C46739';
    const BOOT_SESSION = '2C1A7E44-9B3D-4A02-8F55-1D0C6E9B7A31';
    const SLEEP_WAKE = '7F2B9C10-4E5A-4B88-9C31-0A2D5E7F1B44';
    const INCIDENT_ID = '9D5B0E6B-1F0A-4E77-9A6E-6C7B2E0A0B11';

    function writeDiagnosticReport(
      dir: string,
      fileName: string,
      opts: { name: string; termination?: string; asi?: string },
    ): void {
      const header = JSON.stringify({
        app_name: opts.name,
        name: opts.name,
        bug_type: '309',
        timestamp: '2026-08-27 04:59:58.00 +0000',
      });
      const body = JSON.stringify({
        procName: opts.name,
        procPath: `/Users/test/Applications/${opts.name}.app/Contents/MacOS/${opts.name}`,
        crashReporterKey: DEVICE_KEY,
        bootSessionUUID: BOOT_SESSION,
        sleepWakeUUID: SLEEP_WAKE,
        incident_id: INCIDENT_ID,
        termination: {
          namespace: opts.termination ?? 'USER',
          code: 0,
          indicator: opts.termination ?? 'USER 0',
        },
        asi: { [opts.name]: [opts.asi ?? 'abort() called'] },
      });
      const raw = `${header}\n${body}\n`.replaceAll('/', String.raw`\/`);
      expect(raw).toContain(String.raw`\/Users\/test`);
      writeAt(dir, fileName, raw);
    }

    test('carries the app own report and names the cause', async () => {
      const diagnosticReportsDir = makeTmpDir();
      writeDiagnosticReport(diagnosticReportsDir, 'OpenKnowledge-2026-08-27-045958.ips', {
        name: 'OpenKnowledge',
      });
      const outputPath = join(makeTmpDir(), 'report.zip');

      const { zipPath } = await collectReportBundle({
        level: 'full',
        projectDir: makeFullProjectDir(),
        redact: true,
        outputPath,
        userLogsDir: makeTmpDir(),
        diagnosticReportsDir,
      });

      const entry = 'diagnostic-reports/OpenKnowledge-2026-08-27-045958.ips';
      expect(listZipEntries(zipPath)).toContain(entry);
      expect(readZipEntry(zipPath, entry)).toContain('USER 0');
      expect(readZipEntry(zipPath, 'state/diagnostic-reports-status.txt')).toBe(
        '1 collected (7d; 0 other-process report(s) ignored; 0 unparseable)\n',
      );
    });

    const URL_CREDENTIAL = 'https://svc:s3cretpassword@api.example.com/v1';

    test.each([
      ['with a project in scope', true],
      ['with no project in scope', false],
    ])('scrubs secrets out of a collected report, %s', async (_label, withProject) => {
      const diagnosticReportsDir = makeTmpDir();
      writeDiagnosticReport(diagnosticReportsDir, 'OpenKnowledge-2026-08-27-045958.ips', {
        name: 'OpenKnowledge',
        asi: `fetch failed for ${URL_CREDENTIAL}`,
      });
      const outputPath = join(makeTmpDir(), 'report.zip');

      const { zipPath } = await collectReportBundle({
        level: 'full',
        ...(withProject ? { projectDir: makeFullProjectDir() } : {}),
        redact: true,
        outputPath,
        userLogsDir: makeTmpDir(),
        diagnosticReportsDir,
      });

      const report = readZipEntry(
        zipPath,
        'diagnostic-reports/OpenKnowledge-2026-08-27-045958.ips',
      );
      expect(report).toContain('USER 0');
      expect(report).not.toContain('s3cretpassword');
      expect(report).not.toContain('/Users/test');
      expect(report).not.toContain(DEVICE_KEY);
      expect(report).not.toContain(BOOT_SESSION);
      expect(report).toContain(INCIDENT_ID);
      expect(report).toContain(SLEEP_WAKE);
    });

    test('scrubs secrets out of a truncated report that will not parse', async () => {
      const diagnosticReportsDir = makeTmpDir();
      const header = JSON.stringify({ name: 'OpenKnowledge', bug_type: '309' });
      const torn = `{"procName":"OpenKnowledge","asi":"fetch failed for ${URL_CREDENTIAL}`;
      writeAt(
        diagnosticReportsDir,
        'OpenKnowledge-torn.ips',
        `${header}\n${torn}`.replaceAll('/', String.raw`\/`),
      );
      const outputPath = join(makeTmpDir(), 'report.zip');

      const { zipPath } = await collectReportBundle({
        level: 'full',
        projectDir: makeFullProjectDir(),
        redact: true,
        outputPath,
        userLogsDir: makeTmpDir(),
        diagnosticReportsDir,
      });

      const report = readZipEntry(zipPath, 'diagnostic-reports/OpenKnowledge-torn.ips');
      expect(report).not.toContain('s3cretpassword');
    });

    test('says a report was rewritten even when redaction is disabled', async () => {
      const diagnosticReportsDir = makeTmpDir();
      writeDiagnosticReport(diagnosticReportsDir, 'OpenKnowledge-2026-08-27-045958.ips', {
        name: 'OpenKnowledge',
      });
      const outputPath = join(makeTmpDir(), 'report.zip');

      const { zipPath } = await collectReportBundle({
        level: 'full',
        redact: false,
        outputPath,
        userLogsDir: makeTmpDir(),
        diagnosticReportsDir,
      });

      const readme = readZipEntry(zipPath, 'README.md');
      expect(readme).toContain('Redaction was disabled for this bundle');
      expect(readme).toContain('rewritten on the way in');
      expect(readme).toContain('not byte-identical to the files macOS wrote');
      const report = readZipEntry(
        zipPath,
        'diagnostic-reports/OpenKnowledge-2026-08-27-045958.ips',
      );
      expect(report).not.toContain(DEVICE_KEY);
      expect(report).not.toContain(String.raw`\/Users`);
    });

    test('claims no exception when no report was staged', async () => {
      const outputPath = join(makeTmpDir(), 'report.zip');

      const { zipPath } = await collectReportBundle({
        level: 'full',
        redact: false,
        outputPath,
        userLogsDir: makeTmpDir(),
        diagnosticReportsDir: makeTmpDir(),
      });

      const readme = readZipEntry(zipPath, 'README.md');
      expect(readme).toContain('Redaction was disabled for this bundle');
      expect(readme).not.toContain('exception');
    });

    test('does not carry another application report', async () => {
      const diagnosticReportsDir = makeTmpDir();
      writeDiagnosticReport(diagnosticReportsDir, 'Slack-2026-08-27-045958.ips', { name: 'Slack' });
      const outputPath = join(makeTmpDir(), 'report.zip');

      const { zipPath } = await collectReportBundle({
        level: 'full',
        projectDir: makeFullProjectDir(),
        redact: true,
        outputPath,
        userLogsDir: makeTmpDir(),
        diagnosticReportsDir,
      });

      expect(listZipEntries(zipPath).filter((e) => e.startsWith('diagnostic-reports/'))).toEqual(
        [],
      );
    });

    test('carries the reports and the record when full level has no project in scope', async () => {
      const diagnosticReportsDir = makeTmpDir();
      writeDiagnosticReport(diagnosticReportsDir, 'OpenKnowledge-2026-08-27-045958.ips', {
        name: 'OpenKnowledge',
      });
      writeDiagnosticReport(diagnosticReportsDir, 'Slack-2026-08-27-045958.ips', { name: 'Slack' });
      const outputPath = join(makeTmpDir(), 'report.zip');

      const { zipPath, summary } = await collectReportBundle({
        level: 'full',
        redact: true,
        outputPath,
        userLogsDir: makeTmpDir(),
        diagnosticReportsDir,
      });

      expect(summary.systemWide).toBe(true);
      const entries = listZipEntries(zipPath);
      expect(entries).toContain('diagnostic-reports/OpenKnowledge-2026-08-27-045958.ips');
      expect(entries).not.toContain('diagnostic-reports/Slack-2026-08-27-045958.ips');
      expect(readZipEntry(zipPath, 'state/diagnostic-reports-status.txt')).toBe(
        '1 collected (7d; 1 other-process report(s) ignored; 0 unparseable)\n',
      );
      expect(readZipEntry(zipPath, 'README.md')).toContain('Crash reports: written by macOS');
    });

    test('does not collect at standard level', async () => {
      const diagnosticReportsDir = makeTmpDir();
      writeDiagnosticReport(diagnosticReportsDir, 'OpenKnowledge-2026-08-27-045958.ips', {
        name: 'OpenKnowledge',
      });
      const outputPath = join(makeTmpDir(), 'report.zip');

      const { zipPath } = await collectReportBundle({
        level: 'standard',
        projectDir: makeFullProjectDir(),
        redact: true,
        outputPath,
        userLogsDir: makeTmpDir(),
        diagnosticReportsDir,
      });

      const entries = listZipEntries(zipPath);
      expect(entries.filter((e) => e.startsWith('diagnostic-reports/'))).toEqual([]);
      expect(readZipEntry(zipPath, 'state/diagnostic-reports-status.txt')).toBe(
        'not-collected (no collection attempted)\n',
      );
    });

    test('records an empty window rather than staying silent', async () => {
      const outputPath = join(makeTmpDir(), 'report.zip');

      const { zipPath } = await collectReportBundle({
        level: 'full',
        projectDir: makeFullProjectDir(),
        redact: true,
        outputPath,
        userLogsDir: makeTmpDir(),
        diagnosticReportsDir: makeTmpDir(),
      });

      expect(readZipEntry(zipPath, 'state/diagnostic-reports-status.txt')).toBe(
        'none found in window (7d; 0 other-process report(s) ignored; 0 unparseable)\n',
      );
    });
  });

  test('scrubs ROTATED user logs too, whose counter suffix defeats an extension test', async () => {
    const projectDir = makeFullProjectDir();
    const userLogsDir = makeTmpDir();
    writeAt(
      userLogsDir,
      'desktop.2026-07-28.log.1',
      `${JSON.stringify({ msg: `token ${SECRET}` })}\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    expect(listZipEntries(zipPath)).toContain('logs/desktop.2026-07-28.log.1');
    expect(readZipEntry(zipPath, 'logs/desktop.2026-07-28.log.1')).not.toContain(SECRET);
  });

  test('scrubs credentials in user logs, which are pino JSONL behind a .log suffix', async () => {
    const projectDir = makeFullProjectDir();
    const userLogsDir = makeTmpDir();
    writeAt(
      userLogsDir,
      'desktop.2026-07-28.log',
      `${JSON.stringify({
        attributes: [{ key: 'doc.name', value: { stringValue: 'secret-notes/plan' } }],
        msg: 'token ghp_0123456789abcdefghijABCDEFGHIJ123456 leaked into a log line',
      })}\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entry = readZipEntry(zipPath, 'logs/desktop.2026-07-28.log');
    expect(entry).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJ123456');
    expect(entry).toContain('[REDACTED-');
    expect(entry).toContain('secret-notes/plan');
  });

  test('omits telemetry entirely when the sink has never written', async () => {
    const projectDir = makeTmpDir();
    writeAt(projectDir, '.ok/config.yml', 'name: bare-proj\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
    });

    const entries = listZipEntries(zipPath);
    expect(entries.some((e) => e.startsWith('telemetry/'))).toBe(false);
    expect(entries).toContain('manifest.json');
  });

  test('scrubs seeded credentials while doc names ship raw, with no inverse-map sidecar', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
    });

    const spans = readZipEntry(zipPath, 'telemetry/spans-current.jsonl');
    expect(spans).not.toContain(SECRET);
    expect(spans).toContain('[REDACTED-GH-PAT]');
    expect(spans).toContain('secret-notes/plan');
    expect(spans).not.toMatch(/doc:[a-f0-9]{8}/);
    const manifest = JSON.parse(readZipEntry(zipPath, 'manifest.json'));
    expect(manifest.redaction.applied).toBe(true);
    const scrub = manifest.redaction.secretScrub;
    expect(scrub.redactions.map((r: { file: string }) => r.file)).toContain(
      'telemetry/spans-current.jsonl',
    );
    expect(summary.redactions).toEqual(scrub.redactions);
    expect(summary.redactedLineCount).toBe(scrub.redactedLineCount);
    expect(summary.redactedLineCount).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(dirname(outputPath), 'report.docnames.json'))).toBe(false);
    expect(listZipEntries(zipPath)).not.toContain('report.docnames.json');
  });

  test('canary: planted credentials appear in no full-tier bundle artifact', async () => {
    const projectDir = makeFullProjectDir();
    writeAt(
      projectDir,
      '.ok/local/logs/server-current.jsonl',
      `{"level":50,"msg":"auth failed for ${SECRET}"}\n`,
    );
    writeAt(
      projectDir,
      '.ok/local/loss-capture/loss-current.jsonl',
      `${JSON.stringify({
        ts: 1,
        schemaVersion: 1,
        seq: 1,
        event: 'detector-trip',
        docName: 'notes/plan',
        writerId: `agent ${SECRET}`,
        checkpointSha: 'deadbeef',
      })}\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');
    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
    });

    const textEntries = listZipEntries(zipPath).filter((e) => /\.(jsonl?|txt|log|lock)$/.test(e));
    for (const entry of textEntries) {
      expect(readZipEntry(zipPath, entry)).not.toContain(SECRET);
    }
    const ring = readZipEntry(zipPath, 'state/loss-current.jsonl');
    expect(ring).toContain('notes/plan');
    expect(ring).not.toContain(SECRET);
  });

  test('tier gating: the loss ring rides the full tier only, never the standard tier', async () => {
    const projectDir = makeFullProjectDir();
    writeAt(
      projectDir,
      '.ok/local/loss-capture/loss-current.jsonl',
      `${JSON.stringify({ ts: 1, schemaVersion: 1, seq: 1, event: 'checkpoint-write', docName: 'd' })}\n`,
    );

    const full = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath: join(makeTmpDir(), 'full.zip'),
    });
    expect(listZipEntries(full.zipPath)).toContain('state/loss-current.jsonl');

    const standard = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath: join(makeTmpDir(), 'standard.zip'),
    });
    expect(listZipEntries(standard.zipPath)).not.toContain('state/loss-current.jsonl');
  });

  test('redact: false leaves content unmodified with an empty audit', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: false,
      outputPath,
    });

    const spans = readZipEntry(zipPath, 'telemetry/spans-current.jsonl');
    expect(spans).toContain(SECRET);
    expect(spans).toContain('secret-notes/plan');
    const manifest = JSON.parse(readZipEntry(zipPath, 'manifest.json'));
    expect(manifest.redaction.applied).toBe(false);
    expect(manifest.redaction.secretScrub).toBeUndefined();
    expect(summary.redactions).toEqual([]);
    expect(summary.redactedLineCount).toBe(0);
  });

  test('persists the note and extra files, creating output parents as needed', async () => {
    const projectDir = makeFullProjectDir();
    const sourceDir = makeTmpDir();
    const minidump = Buffer.concat([
      Buffer.from([0x4d, 0x44, 0x4d, 0x50, 0x00, 0xff]),
      Buffer.from(SECRET),
    ]);
    writeAt(sourceDir, 'crash.dmp', minidump);
    const outputPath = join(makeTmpDir(), 'nested', 'sub', 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      note: 'Editor froze after paste',
      redact: true,
      outputPath,
      extraFiles: [{ sourcePath: join(sourceDir, 'crash.dmp') }],
    });

    expect(readZipEntry(zipPath, 'note.txt')).toBe('Editor froze after paste');
    const bundled = readZipEntryBuffer(zipPath, 'extra/crash.dmp');
    expect(bundled.equals(minidump)).toBe(true);
    const manifest = JSON.parse(readZipEntry(zipPath, 'manifest.json'));
    const paths = manifest.files.map((f: { path: string }) => f.path);
    expect(paths).toContain('note.txt');
    expect(paths).toContain('extra/crash.dmp');
    expect(summary.files).toContain('note.txt');
    expect(summary.files).toContain('extra/crash.dmp');
  });

  test('scrubs a secret pasted into the note', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      note: `it broke after ${SECRET}`,
      redact: true,
      outputPath,
    });

    const note = readZipEntry(zipPath, 'note.txt');
    expect(note).not.toContain(SECRET);
    expect(note).toContain('[REDACTED-GH-PAT]');
    expect(summary.redactions.some((r) => r.file === 'note.txt')).toBe(true);
  });

  test('falls back to the system-wide standard set when no project is in scope', async () => {
    const userLogsDir = makeTmpDir();
    writeAt(userLogsDir, 'cli.log', 'started\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('MANIFEST.json');
    expect(entries).toContain('sysinfo.json');
    expect(entries).toContain('logs/cli.log');
    expect(entries).not.toContain('manifest.json');
    expect(summary.level).toBe('full');
    expect(summary.systemWide).toBe(true);
    expect(summary.projectSlug).toBeNull();
  });

  test('resolves content.dir from the project config for the full capture', async () => {
    const projectDir = makeTmpDir();
    writeAt(projectDir, '.ok/config.yml', 'name: split-proj\ncontent:\n  dir: docs\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: false,
      outputPath,
    });

    const manifest = JSON.parse(readZipEntry(zipPath, 'manifest.json'));
    expect(manifest.contentDir.absolutePath).toBe(resolve(projectDir, 'docs'));
  });
});

describe('collectReportBundle — desktop metadata seam', () => {
  const DESKTOP = { electronVersion: '1.2.3', packaged: true, channel: 'latest' };

  test('injected desktop metadata lands in the standard sysinfo and manifest', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
      readDesktopEnv: () => DESKTOP,
    });

    expect(JSON.parse(readZipEntry(zipPath, 'sysinfo.json')).desktop).toEqual(DESKTOP);
    expect(JSON.parse(readZipEntry(zipPath, 'MANIFEST.json')).sysinfo.desktop).toEqual(DESKTOP);
  });

  test('injected desktop metadata lands in the full runtime block', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: false,
      outputPath,
      readDesktopEnv: () => DESKTOP,
    });

    expect(JSON.parse(readZipEntry(zipPath, 'state/runtime.json')).host.desktop).toEqual(DESKTOP);
  });

  test('a null seam records desktop: null at the standard level (not an Electron host)', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
      readDesktopEnv: () => null,
    });

    expect(JSON.parse(readZipEntry(zipPath, 'sysinfo.json')).desktop).toBeNull();
  });
});

describe('collectReportBundle — interface-language seam', () => {
  const LANGUAGE = {
    preference: 'system',
    locale: 'es',
    source: 'system',
    systemLanguages: ['es-ES', 'en-US'],
  } as const satisfies LanguageMetadata;

  test('injected language lands in the standard sysinfo and manifest', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
      readLanguage: () => LANGUAGE,
    });

    expect(JSON.parse(readZipEntry(zipPath, 'sysinfo.json')).language).toEqual(LANGUAGE);
    expect(JSON.parse(readZipEntry(zipPath, 'MANIFEST.json')).sysinfo.language).toEqual(LANGUAGE);
  });

  test('injected language lands in the full runtime block and manifest host', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: false,
      outputPath,
      readLanguage: () => LANGUAGE,
    });

    expect(JSON.parse(readZipEntry(zipPath, 'state/runtime.json')).host.language).toEqual(LANGUAGE);
    expect(JSON.parse(readZipEntry(zipPath, 'manifest.json')).host.language).toEqual(LANGUAGE);
  });

  test('an explicit choice is recorded unresolved beside what it resolved to', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
      readLanguage: () => ({
        preference: 'ar',
        locale: 'ar',
        source: 'explicit',
        systemLanguages: ['en-US'],
      }),
    });

    const { language } = JSON.parse(readZipEntry(zipPath, 'sysinfo.json'));
    expect(language.preference).toBe('ar');
    expect(language.source).toBe('explicit');
  });

  test('the default seam still records a language block at both levels', async () => {
    const standardOut = join(makeTmpDir(), 'standard.zip');
    const fullOut = join(makeTmpDir(), 'full.zip');

    const standard = await collectReportBundle({
      level: 'standard',
      projectDir: makeStandardProjectDir(),
      redact: true,
      outputPath: standardOut,
    });
    const full = await collectReportBundle({
      level: 'full',
      projectDir: makeFullProjectDir(),
      redact: false,
      outputPath: fullOut,
    });

    const standardLanguage = JSON.parse(readZipEntry(standard.zipPath, 'sysinfo.json')).language;
    expect(typeof standardLanguage.locale).toBe('string');
    expect(typeof standardLanguage.preference).toBe('string');
    expect(JSON.parse(readZipEntry(full.zipPath, 'manifest.json')).host).toHaveProperty('language');
  });
});

describe('collectReportBundle — opted-in extras that cannot be staged', () => {
  function makeRecordingLogger() {
    const warnings: Array<{ payload: Record<string, unknown>; message: string }> = [];
    return {
      logger: {
        info: () => {},
        warn: (payload: Record<string, unknown>, message: string) => {
          warnings.push({ payload, message });
        },
      },
      warnings,
    };
  }

  test('standard level warns when an extra is unreadable and still builds the bundle', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');
    const missingDump = join(makeTmpDir(), 'vanished.dmp');
    const { logger, warnings } = makeRecordingLogger();

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
      extraFiles: [{ sourcePath: missingDump }],
      logger,
    });

    expect(existsSync(zipPath)).toBe(true);
    expect(summary.files.some((f) => f.startsWith('extra/'))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.payload.sourcePath).toBe(missingDump);
  });

  test('full level warns when an extra is missing on disk and still builds the bundle', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');
    const missingDump = join(makeTmpDir(), 'vanished.dmp');
    const { logger, warnings } = makeRecordingLogger();

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
      extraFiles: [{ sourcePath: missingDump }],
      logger,
    });

    expect(existsSync(zipPath)).toBe(true);
    expect(summary.files.some((f) => f.startsWith('extra/'))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.payload.sourcePath).toBe(missingDump);
  });
});

describe('collectReportBundle — package surface', () => {
  test('is exported from the package index', () => {
    expect(collectReportBundleFromIndex).toBe(collectReportBundle);
  });
});

describe('collectReportBundle — bug-report send ledger', () => {
  const LEDGER_YAML = [
    'version: 1',
    'id: 2026-08-19T16-42-03-547Z-bugreport.zip',
    'createdAt: 2026-08-19T16:42:03.547Z',
    'bundleLevel: full',
    'state: upload-failed',
    'lastError:',
    '  reason: upload-network-error',
    '  at: 2026-08-19T16:42:19.000Z',
    'attempts:',
    '  - at: 2026-08-19T16:42:03.547Z',
    '    transport: upload',
    '    outcome: failed',
    '    error: upload-network-error',
    '',
  ].join('\n');

  function makeBugReportsDir(): string {
    const dir = makeTmpDir('ok-bug-reports-');
    writeAt(dir, '2026-08-19T16-42-03-547Z-bugreport.yaml', LEDGER_YAML);
    writeAt(dir, '2026-08-19T16-42-03-547Z-bugreport.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    return dir;
  }

  test('full level stages the ledger so a failed send is answerable from the bundle', async () => {
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir: makeFullProjectDir(),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      bugReportsDir: makeBugReportsDir(),
    });

    const entry = 'state/bug-reports/2026-08-19T16-42-03-547Z-bugreport.yaml';
    expect(listZipEntries(zipPath)).toContain(entry);
    expect(summary.files).toContain(entry);
    expect(readZipEntry(zipPath, entry)).toContain('upload-network-error');
  });

  test('standard level stages it too', async () => {
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'standard',
      projectDir: makeStandardProjectDir(),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      bugReportsDir: makeBugReportsDir(),
    });

    expect(listZipEntries(zipPath)).toContain(
      'state/bug-reports/2026-08-19T16-42-03-547Z-bugreport.yaml',
    );
  });

  test('neither level stages the zip payloads sitting beside the sidecars', async () => {
    for (const level of ['standard', 'full'] as const) {
      const outputPath = join(makeTmpDir(), `${level}.zip`);
      const { zipPath } = await collectReportBundle({
        level,
        projectDir: level === 'full' ? makeFullProjectDir() : makeStandardProjectDir(),
        redact: true,
        outputPath,
        userLogsDir: makeTmpDir(),
        bugReportsDir: makeBugReportsDir(),
      });

      expect(listZipEntries(zipPath).filter((e) => e.endsWith('-bugreport.zip'))).toEqual([]);
    }
  });

  test('the ledger goes through the secret scrub like every other staged text file', async () => {
    const dir = makeTmpDir('ok-bug-reports-');
    writeAt(
      dir,
      '2026-08-19T16-42-03-547Z-bugreport.yaml',
      `${LEDGER_YAML}note: it died right after I pasted ${SECRET}\n`,
    );

    for (const level of ['standard', 'full'] as const) {
      const outputPath = join(makeTmpDir(), `${level}.zip`);
      const { zipPath } = await collectReportBundle({
        level,
        projectDir: level === 'full' ? makeFullProjectDir() : makeStandardProjectDir(),
        redact: true,
        outputPath,
        userLogsDir: makeTmpDir(),
        bugReportsDir: dir,
      });

      const body = readZipEntry(
        zipPath,
        'state/bug-reports/2026-08-19T16-42-03-547Z-bugreport.yaml',
      );
      expect(body).toContain('upload-network-error');
      expect(body).not.toContain(SECRET);
    }
  });

  test('a dir with dozens of reports contributes a bounded, newest-first slice', async () => {
    const dir = makeTmpDir('ok-bug-reports-');
    for (let i = 0; i < 40; i += 1) {
      const stamp = `2026-08-${String((i % 28) + 1).padStart(2, '0')}T10-00-${String(i).padStart(2, '0')}-000Z`;
      writeAt(dir, `${stamp}-bugreport.yaml`, `id: ${stamp}-bugreport.zip\nstate: sent\n`);
    }
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir: makeFullProjectDir(),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      bugReportsDir: dir,
    });

    const staged = listZipEntries(zipPath).filter((e) => e.startsWith('state/bug-reports/'));
    expect(staged.length).toBe(25);
    expect(staged).toContain('state/bug-reports/2026-08-28T10-00-27-000Z-bugreport.yaml');
    expect(staged).not.toContain('state/bug-reports/2026-08-01T10-00-00-000Z-bugreport.yaml');
  });

  test('an absent reports dir is not an error', async () => {
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir: makeFullProjectDir(),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      bugReportsDir: join(makeTmpDir(), 'does-not-exist'),
    });

    expect(existsSync(zipPath)).toBe(true);
    expect(listZipEntries(zipPath).filter((e) => e.startsWith('state/bug-reports/'))).toEqual([]);
  });
});

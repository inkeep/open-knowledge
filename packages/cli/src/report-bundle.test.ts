/**
 * Tests for the leveled report-bundle entry. Real disk fixtures (no fs
 * mocks) matching the bug-report-bundle conventions: injected userLogsDir
 * keeps tests off the real `~/.ok`, and zip verification shells out to
 * `unzip` rather than adding a parser dep.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { collectReportBundle as collectReportBundleFromIndex } from './index.ts';
import { collectReportBundle } from './report-bundle.ts';

const tmpDirs: string[] = [];

function makeTmpDir(prefix = 'ok-report-test-'): string {
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

/** A project with telemetry + log sinks but no shadow repo and no server lock. */
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
    // No shadow repo and no server lock in the fixture: both pieces are
    // omitted, and the bundled manifest inventory reflects the omission.
    expect(entries).not.toContain('state/shadow-head.txt');
    expect(entries).not.toContain('state/server.lock');
    expect(entries).not.toContain('state/agent-presence.json');
    const manifest = JSON.parse(readZipEntry(zipPath, 'manifest.json'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.serverStatus).toBe('not-running');
    const paths = manifest.files.map((f: { path: string }) => f.path);
    expect(paths).not.toContain('state/shadow-head.txt');
    expect(summary.level).toBe('full');
    expect(summary.systemWide).toBe(false);
    expect(summary.projectSlug).toBe('full-proj');
    expect(summary.files).toEqual(paths);
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

  test('scrubs seeded secrets, hashes doc names, and reports the audit', async () => {
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
    expect(spans).not.toContain('secret-notes/plan');
    expect(spans).toContain('doc:');
    const manifest = JSON.parse(readZipEntry(zipPath, 'manifest.json'));
    expect(manifest.redaction.applied).toBe(true);
    const scrub = manifest.redaction.secretScrub;
    expect(scrub.redactions.map((r: { file: string }) => r.file)).toContain(
      'telemetry/spans-current.jsonl',
    );
    expect(summary.redactions).toEqual(scrub.redactions);
    expect(summary.redactedLineCount).toBe(scrub.redactedLineCount);
    expect(summary.redactedLineCount).toBeGreaterThanOrEqual(1);
    // Inverse doc-name map lands as a sidecar next to the zip, never inside.
    expect(existsSync(join(dirname(outputPath), 'report.docnames.json'))).toBe(true);
    expect(listZipEntries(zipPath)).not.toContain('report.docnames.json');
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

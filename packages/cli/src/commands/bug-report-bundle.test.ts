/**
 * Tests for the standard bug-report capture. Real disk fixtures (no fs
 * mocks) since the module's job is filesystem-shaped; the user-level logs
 * directory is injected so tests never touch the real `~/.ok`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  collectStandardBundle,
  defaultBugReportZipPath,
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

// yazl writes; the standard parser pair is yauzl. Avoid adding it as a
// dep for tests — use `unzip` (BSD/Linux ships it) instead.
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
    writeFileSync(join(userLogsDir, 'match.log'), '{"project":"bundle-proj"}\n');
    writeFileSync(join(userLogsDir, 'other.log'), '{"project":"someone-else"}\n');
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/match.log');
    expect(entries).not.toContain('logs/other.log');
  });

  test('keeps every user log when none mention the project slug', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'a.log'), 'no slug here\n');
    writeFileSync(join(userLogsDir, 'b.log'), 'none here either\n');
    const projectDir = makeProjectDir('bundle-proj');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectStandardBundle({
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/a.log');
    expect(entries).toContain('logs/b.log');
  });
});

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

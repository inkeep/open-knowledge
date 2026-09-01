import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  collectDiagnosticReports,
  prepareDiagnosticReportText,
  renderDiagnosticReportsStatus,
} from './diagnostic-reports.ts';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ok-diagnostic-reports-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

const NOW = new Date('2026-08-27T12:00:00.000Z');

function hoursBefore(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
}

function daysBefore(days: number): Date {
  return hoursBefore(days * 24);
}

function headerTimestamp(at: Date, offsetHours = 0): string {
  const shifted = new Date(at.getTime() + offsetHours * 60 * 60 * 1000);
  const sign = offsetHours < 0 ? '-' : '+';
  const abs = Math.abs(offsetHours);
  const offset = `${sign}${String(abs).padStart(2, '0')}00`;
  return `${shifted.toISOString().slice(0, 10)} ${shifted.toISOString().slice(11, 19)}.00 ${offset}`;
}

function writeReport(
  dir: string,
  fileName: string,
  opts: {
    name: string;
    at?: Date;
    incidentAt?: Date;
    incidentOffsetHours?: number;
    body?: Record<string, unknown>;
    raw?: string;
  },
): string {
  const path = join(dir, fileName);
  const at = opts.at ?? daysBefore(1);
  const header = JSON.stringify({
    app_name: opts.name,
    name: opts.name,
    bug_type: '309',
    timestamp: headerTimestamp(opts.incidentAt ?? at, opts.incidentOffsetHours ?? 0),
    os_version: 'macOS 26.6.2 (25G83)',
  });
  const body = JSON.stringify(
    opts.body ?? {
      procName: opts.name,
      termination: { namespace: 'SIGNAL', code: 6, indicator: 'Abort trap: 6' },
    },
    null,
    2,
  );
  writeFileSync(path, opts.raw ?? `${header}\n${body}\n`);
  utimesSync(path, at, at);
  return path;
}

function collectedNames(dir: string): string[] {
  return collectDiagnosticReports(dir, NOW).files.map((f) => basename(f));
}

function statusOf(dir: string): string {
  const collected = collectDiagnosticReports(dir, NOW);
  return renderDiagnosticReportsStatus(collected, collected.files.length);
}

describe('prepareDiagnosticReportText', () => {
  test('rewrites the escaped solidus macOS writes', () => {
    expect(prepareDiagnosticReportText(String.raw`"\/Users\/test\/notes"`)).toBe(
      '"/Users/test/notes"',
    );
  });

  test('leaves an already-unescaped report byte-identical', () => {
    const plain = '{"name":"OpenKnowledge"}\n{"procPath":"/Applications/OpenKnowledge.app"}\n';
    expect(prepareDiagnosticReportText(plain)).toBe(plain);
  });

  test('preserves a literal backslash that precedes a solidus', () => {
    const encoded = String.raw`"C:\\/file"`;
    expect(JSON.parse(encoded)).toBe(String.raw`C:\/file`);
    expect(JSON.parse(prepareDiagnosticReportText(encoded))).toBe(String.raw`C:\/file`);
  });

  test('leaves 64-bit register values exactly as written', () => {
    const body = '{"threads":[{"threadState":{"x":[{"value":18446744072631617535}]}}]}';
    expect(prepareDiagnosticReportText(body)).toContain('18446744072631617535');
    expect(JSON.stringify(JSON.parse(body))).not.toContain('18446744072631617535');
  });
  test('replaces the linking identifiers, keeping the per-incident ones', () => {
    const raw = [
      '{',
      '  "crashReporterKey" : "03BEA1C8-0E42-2631-A65B-FB48F8C46739",',
      '  "bootSessionUUID" : "2C1A7E44-9B3D-4A02-8F55-1D0C6E9B7A31",',
      '  "sleepWakeUUID" : "7F2B9C10-4E5A-4B88-9C31-0A2D5E7F1B44",',
      '  "incident_id" : "9D5B0E6B-1F0A-4E77-9A6E-6C7B2E0A0B11"',
      '}',
    ].join('\n');

    const after = prepareDiagnosticReportText(raw);

    expect(after).not.toContain('03BEA1C8-0E42-2631-A65B-FB48F8C46739');
    expect(after).not.toContain('2C1A7E44-9B3D-4A02-8F55-1D0C6E9B7A31');
    expect(after).toContain('"crashReporterKey" : "[REDACTED-DEVICE-ID]"');
    expect(after).toContain('"bootSessionUUID" : "[REDACTED-DEVICE-ID]"');
    expect(after).toContain('7F2B9C10-4E5A-4B88-9C31-0A2D5E7F1B44');
    expect(after).toContain('9D5B0E6B-1F0A-4E77-9A6E-6C7B2E0A0B11');
    expect(() => JSON.parse(after)).not.toThrow();
  });

  test('does not backtrack on a long backslash run', () => {
    const run = `${'\\'.repeat(100_000)}x`;
    const started = Date.now();
    expect(prepareDiagnosticReportText(run)).toBe(run);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('collectDiagnosticReports', () => {
  test('collects a report for the app main process', () => {
    const dir = makeTmpDir();
    writeReport(dir, 'OpenKnowledge-2026-08-27-045958.ips', { name: 'OpenKnowledge' });

    const result = collectDiagnosticReports(dir, NOW);

    expect(result.files.map((f) => basename(f))).toEqual(['OpenKnowledge-2026-08-27-045958.ips']);
    expect(result.outcome).toBe('collected');
    expect(renderDiagnosticReportsStatus(result, result.files.length)).toContain('1 collected');
  });

  test('collects every helper variant, including the one the detached server runs as', () => {
    const dir = makeTmpDir();
    writeReport(dir, 'OpenKnowledge Helper-2026-08-27-045958.ips', {
      name: 'OpenKnowledge Helper',
    });
    writeReport(dir, 'OpenKnowledge Helper (GPU)-2026-08-27-045959.ips', {
      name: 'OpenKnowledge Helper (GPU)',
    });
    writeReport(dir, 'OpenKnowledge Helper (Renderer)-2026-08-27-050000.ips', {
      name: 'OpenKnowledge Helper (Renderer)',
    });

    expect(collectedNames(dir)).toHaveLength(3);
  });

  test('never harvests another application report', () => {
    const dir = makeTmpDir();
    writeReport(dir, 'OpenKnowledge-2026-08-27-045958.ips', { name: 'OpenKnowledge' });
    writeReport(dir, 'Slack-2026-08-27-045958.ips', { name: 'Slack' });
    writeReport(dir, 'bash-2026-08-27-045958.ips', { name: 'bash' });
    writeReport(dir, 'node-2026-08-27-045958.ips', { name: 'node' });

    const result = collectDiagnosticReports(dir, NOW);

    expect(result.files.map((f) => basename(f))).toEqual(['OpenKnowledge-2026-08-27-045958.ips']);
    expect(result.foreignIgnored).toBe(3);
    expect(renderDiagnosticReportsStatus(result, result.files.length)).toContain(
      '3 other-process report(s) ignored',
    );
  });

  test('does not collect an unrelated app whose name shares the prefix', () => {
    const dir = makeTmpDir();
    writeReport(dir, 'OpenKnowledgeBase-2026-08-27-045958.ips', { name: 'OpenKnowledgeBase' });

    expect(collectedNames(dir)).toEqual([]);
  });

  test('skips a directory even when its name ends in .ips', () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, 'Retired.ips'));
    writeReport(dir, 'OpenKnowledge-2026-08-27-045958.ips', { name: 'OpenKnowledge' });

    const result = collectDiagnosticReports(dir, NOW);

    expect(result.files.map((f) => basename(f))).toEqual(['OpenKnowledge-2026-08-27-045958.ips']);
    expect(result.unparseable).toBe(0);
  });

  test('ignores a valid owned report that does not carry the .ips extension', () => {
    const dir = makeTmpDir();
    writeReport(dir, 'OpenKnowledge-2026-08-27-045958.diag', { name: 'OpenKnowledge' });

    const result = collectDiagnosticReports(dir, NOW);

    expect(result.files).toEqual([]);
    expect(result.foreignIgnored).toBe(0);
    expect(result.unparseable).toBe(0);
  });

  test('collects up to the seven-day boundary and no further', () => {
    const dir = makeTmpDir();
    writeReport(dir, 'OpenKnowledge-inside.ips', {
      name: 'OpenKnowledge',
      at: hoursBefore(6 * 24 + 23),
    });
    writeReport(dir, 'OpenKnowledge-outside.ips', {
      name: 'OpenKnowledge',
      at: hoursBefore(7 * 24 + 1),
    });

    expect(collectedNames(dir)).toEqual(['OpenKnowledge-inside.ips']);
  });

  test('caps the collection and keeps the newest reports', () => {
    const dir = makeTmpDir();
    for (let i = 0; i < 30; i += 1) {
      writeReport(dir, `OpenKnowledge-${String(i).padStart(2, '0')}.ips`, {
        name: 'OpenKnowledge',
        at: new Date(NOW.getTime() - (30 - i) * 60 * 1000),
      });
    }

    const result = collectDiagnosticReports(dir, NOW);
    const names = result.files.map((f) => basename(f));

    expect(names).toHaveLength(25);
    expect(names[0]).toBe('OpenKnowledge-29.ips');
    expect(names).not.toContain('OpenKnowledge-00.ips');
    expect(result.droppedOverCap).toBe(5);
    expect(renderDiagnosticReportsStatus(result, result.files.length)).toContain(
      '5 older dropped over cap',
    );
  });

  test('orders by the incident time in the header, not by mtime', () => {
    const dir = makeTmpDir();
    writeReport(dir, 'OpenKnowledge-stale-but-touched.ips', {
      name: 'OpenKnowledge',
      at: hoursBefore(1),
      incidentAt: hoursBefore(100),
    });
    writeReport(dir, 'OpenKnowledge-recent.ips', {
      name: 'OpenKnowledge',
      at: hoursBefore(50),
      incidentAt: hoursBefore(2),
    });

    expect(collectedNames(dir)).toEqual([
      'OpenKnowledge-recent.ips',
      'OpenKnowledge-stale-but-touched.ips',
    ]);
  });

  test('orders by the instant the offset denotes, not the printed wall clock', () => {
    const dir = makeTmpDir();
    const sameMtime = hoursBefore(1);
    writeReport(dir, 'OpenKnowledge-later-instant.ips', {
      name: 'OpenKnowledge',
      at: sameMtime,
      incidentAt: NOW,
      incidentOffsetHours: -7,
    });
    writeReport(dir, 'OpenKnowledge-earlier-instant.ips', {
      name: 'OpenKnowledge',
      at: sameMtime,
      incidentAt: hoursBefore(3),
      incidentOffsetHours: 0,
    });

    expect(collectedNames(dir)).toEqual([
      'OpenKnowledge-later-instant.ips',
      'OpenKnowledge-earlier-instant.ips',
    ]);
  });

  test('windows on mtime while ordering on the incident time', () => {
    const dir = makeTmpDir();
    writeReport(dir, 'OpenKnowledge-old-incident-fresh-mtime.ips', {
      name: 'OpenKnowledge',
      at: hoursBefore(1),
      incidentAt: daysBefore(10),
    });
    writeReport(dir, 'OpenKnowledge-recent-incident.ips', {
      name: 'OpenKnowledge',
      at: hoursBefore(50),
      incidentAt: hoursBefore(2),
    });

    expect(collectedNames(dir)).toEqual([
      'OpenKnowledge-recent-incident.ips',
      'OpenKnowledge-old-incident-fresh-mtime.ips',
    ]);
  });

  test('falls back to mtime when the header timestamp does not parse', () => {
    const dir = makeTmpDir();
    const header = JSON.stringify({
      app_name: 'OpenKnowledge',
      name: 'OpenKnowledge',
      bug_type: '309',
      timestamp: 'Thu Aug 27 04:59:58 2026',
    });
    writeReport(dir, 'OpenKnowledge-odd-timestamp.ips', {
      name: 'OpenKnowledge',
      at: hoursBefore(1),
      raw: `${header}\n{"procName":"OpenKnowledge"}\n`,
    });
    writeReport(dir, 'OpenKnowledge-older.ips', {
      name: 'OpenKnowledge',
      at: hoursBefore(40),
    });

    expect(collectedNames(dir)).toEqual([
      'OpenKnowledge-odd-timestamp.ips',
      'OpenKnowledge-older.ips',
    ]);
  });

  test('falls back to mtime when the header carries no usable timestamp', () => {
    const dir = makeTmpDir();
    const header = JSON.stringify({ name: 'OpenKnowledge', bug_type: '309' });
    writeReport(dir, 'OpenKnowledge-no-timestamp.ips', {
      name: 'OpenKnowledge',
      at: hoursBefore(2),
      raw: `${header}\n{}\n`,
    });
    writeReport(dir, 'OpenKnowledge-older.ips', { name: 'OpenKnowledge', at: hoursBefore(3) });

    expect(collectedNames(dir)).toEqual([
      'OpenKnowledge-no-timestamp.ips',
      'OpenKnowledge-older.ips',
    ]);
  });

  describe('reports we cannot identify', () => {
    test('counts an unparseable header apart from another application report', () => {
      const dir = makeTmpDir();
      writeReport(dir, 'garbled.ips', { name: 'OpenKnowledge', raw: 'not json at all\n{}\n' });
      writeReport(dir, 'Slack-2026-08-27-045958.ips', { name: 'Slack' });

      const result = collectDiagnosticReports(dir, NOW);

      expect(result.files).toEqual([]);
      expect(result.unparseable).toBe(1);
      expect(result.foreignIgnored).toBe(1);
      expect(renderDiagnosticReportsStatus(result, result.files.length)).toBe(
        'none found in window (7d; 1 other-process report(s) ignored; 1 unparseable)',
      );
    });

    test('counts a header that parses but names no process', () => {
      const dir = makeTmpDir();
      writeReport(dir, 'Nameless-2026-08-27.ips', {
        name: 'OpenKnowledge',
        at: hoursBefore(1),
        raw: `${JSON.stringify({ bug_type: '298', timestamp: '2026-08-27 04:59:58.00 +0000' })}\n{}\n`,
      });

      const result = collectDiagnosticReports(dir, NOW);

      expect(result.files).toEqual([]);
      expect(result.unparseable).toBe(1);
      expect(result.foreignIgnored).toBe(0);
    });

    test('reads a header that is the whole file, with no trailing newline', () => {
      const dir = makeTmpDir();
      const header = JSON.stringify({
        name: 'OpenKnowledge',
        bug_type: '309',
        timestamp: headerTimestamp(daysBefore(1)),
      });
      writeReport(dir, 'OpenKnowledge-partial.ips', { name: 'OpenKnowledge', raw: header });

      const result = collectDiagnosticReports(dir, NOW);

      expect(result.files.map((f) => basename(f))).toEqual(['OpenKnowledge-partial.ips']);
      expect(result.unparseable).toBe(0);
    });
  });

  describe('status when nothing is collected', () => {
    test('reports a missing directory as not-present', () => {
      const result = collectDiagnosticReports(join(makeTmpDir(), 'absent'), NOW);

      expect(result.files).toEqual([]);
      expect(result.outcome).toBe('not-present');
      expect(renderDiagnosticReportsStatus(result, result.files.length)).toBe(
        'not-present (no DiagnosticReports directory)',
      );
    });

    test('reports a directory it could not read distinctly, naming the errno', () => {
      const dir = makeTmpDir();
      const notADirectory = join(dir, 'DiagnosticReports');
      writeFileSync(notADirectory, 'this is a file');

      const result = collectDiagnosticReports(notADirectory, NOW);

      expect(result.outcome).toBe('unreadable-directory');
      expect(renderDiagnosticReportsStatus(result, result.files.length)).toBe(
        'unreadable (ENOTDIR reading DiagnosticReports)',
      );
    });

    test('reports an empty window distinctly from a missing directory', () => {
      const dir = makeTmpDir();
      writeReport(dir, 'Slack-2026-08-27-045958.ips', { name: 'Slack' });

      expect(statusOf(dir)).toBe(
        'none found in window (7d; 1 other-process report(s) ignored; 0 unparseable)',
      );
    });
  });

  test('renders the staged count when it falls short of what was selected', () => {
    const dir = makeTmpDir();
    writeReport(dir, 'OpenKnowledge-a.ips', { name: 'OpenKnowledge' });
    writeReport(dir, 'OpenKnowledge-b.ips', { name: 'OpenKnowledge' });

    const result = collectDiagnosticReports(dir, NOW);

    expect(renderDiagnosticReportsStatus(result, 1)).toBe(
      '1 collected (7d; 0 other-process report(s) ignored; 0 unparseable; 1 vanished before staging)',
    );
  });
});

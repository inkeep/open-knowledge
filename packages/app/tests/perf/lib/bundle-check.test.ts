import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { assertBundleHealth, BASELINE_INDEX_GZIPPED_KB } from './bundle-check.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bundle-check-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  writeFileSync(join(dir, 'assets', relPath), content);
}

function fakeIndexChunk(): string {
  return 'console.log("ok-index-stub");\n'.repeat(50);
}

function fakeTelemetryChunk(): string {
  let s = '';
  let n = 1;
  for (let i = 0; i < 27_500; i += 1) {
    n = (n * 16807) % 2_147_483_647;
    s += String.fromCharCode(33 + (n % 90));
  }
  return s;
}

describe('assertBundleHealth', () => {
  test('passes when all assertions hold (clean fake dist/)', () => {
    write('telemetry-impl-abc123.js', fakeTelemetryChunk());
    write('index-def456.js', fakeIndexChunk());
    const report = assertBundleHealth({ distAssetsDir: join(dir, 'assets') });
    if (!report.ok) {
      throw new Error(`assertBundleHealth failed: ${report.failures.join('; ')}`);
    }
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.telemetryChunkGzippedKb).toBeGreaterThanOrEqual(21);
    expect(report.telemetryChunkGzippedKb).toBeLessThanOrEqual(23);
  });

  test("fails when '__ok_perf' literal appears in a non-telemetry chunk (DEV-only DCE regression)", () => {
    write('telemetry-impl-abc.js', fakeTelemetryChunk());
    write('index-def.js', `${fakeIndexChunk()}\nvar __ok_perf = {};`);
    const report = assertBundleHealth({ distAssetsDir: join(dir, 'assets') });
    expect(report.ok).toBe(false);
    expect(report.forbiddenHits.some((h) => h.sentinel === '__ok_perf')).toBe(true);
  });

  test("fails when 'ok-hdr-histogram-v1' sentinel appears in a prod chunk", () => {
    write('telemetry-impl-abc.js', fakeTelemetryChunk());
    write('index-def.js', `${fakeIndexChunk()}\nconsole.log("ok-hdr-histogram-v1");`);
    const report = assertBundleHealth({ distAssetsDir: join(dir, 'assets') });
    expect(report.ok).toBe(false);
    expect(report.forbiddenHits.some((h) => h.sentinel === 'ok-hdr-histogram-v1')).toBe(true);
  });

  test("fails when 'ok-typing-burst-detector-v1' sentinel appears in a prod chunk", () => {
    write('telemetry-impl-abc.js', fakeTelemetryChunk());
    write('index-def.js', `${fakeIndexChunk()}\nconst x = "ok-typing-burst-detector-v1";`);
    const report = assertBundleHealth({ distAssetsDir: join(dir, 'assets') });
    expect(report.ok).toBe(false);
    expect(report.forbiddenHits.some((h) => h.sentinel === 'ok-typing-burst-detector-v1')).toBe(
      true,
    );
  });

  test("fails when '__acpThreadHarness' appears in a prod chunk", () => {
    write('telemetry-impl-abc.js', fakeTelemetryChunk());
    write('index-def.js', `${fakeIndexChunk()}\nwindow.__acpThreadHarness = {};`);
    const report = assertBundleHealth({ distAssetsDir: join(dir, 'assets') });
    expect(report.ok).toBe(false);
    expect(report.forbiddenHits.some((h) => h.sentinel === '__acpThreadHarness')).toBe(true);
  });

  test('reports missing telemetry chunk', () => {
    write('index-def.js', fakeIndexChunk());
    const report = assertBundleHealth({ distAssetsDir: join(dir, 'assets') });
    expect(report.ok).toBe(false);
    expect(report.failures.some((f) => f.includes('telemetry-impl-*.js to exist'))).toBe(true);
  });

  test('warns when distAssetsDir is missing instead of throwing', () => {
    const report = assertBundleHealth({ distAssetsDir: '/this/path/does/not/exist' });
    expect(report.ok).toBe(false);
    expect(report.failures[0]).toContain('dist/assets not found');
  });

  test('exposes the recorded baseline constants for observability', () => {
    expect(BASELINE_INDEX_GZIPPED_KB).toBe(340.84);
  });
});

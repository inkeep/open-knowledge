import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isReLintFailedWarning,
  type LintFixResult,
  LintFixResultSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness.ts';

const postFixLintFault = vi.hoisted(() => ({ active: false, calls: 0 }));
const postFixSourceFault = vi.hoisted(() => ({ active: false, calls: 0 }));
const postFixEmptyMessageFault = vi.hoisted(() => ({ active: false, calls: 0 }));
const preFixSourceFault = vi.hoisted(() => ({ active: false, calls: 0 }));

vi.mock('@inkeep/open-knowledge-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inkeep/open-knowledge-core')>();
  return {
    ...actual,
    lintDocument: (...args: Parameters<typeof actual.lintDocument>) => {
      const [source] = args;
      if (postFixLintFault.active && !source.includes('\t')) {
        postFixLintFault.calls += 1;
        throw new Error('re-lint exploded');
      }
      if (postFixEmptyMessageFault.active && !source.includes('\t')) {
        postFixEmptyMessageFault.calls += 1;
        throw new Error('');
      }
      if (preFixSourceFault.active) {
        const report = args[3] as ((failure: unknown) => void) | undefined;
        const at = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
        if (source.includes('\t')) {
          preFixSourceFault.calls += 1;
          report?.({
            source: 'markdownlint',
            phase: 'lint',
            message: 'source exploded on the pre-fix text',
          });
          return [
            { range: at, severity: 'warning', source: 'okf', code: 'OKF001', message: 'one' },
            { range: at, severity: 'warning', source: 'okf', code: 'OKF002', message: 'two' },
          ];
        }
        return [
          {
            range: at,
            severity: 'warning',
            source: 'markdownlint',
            code: 'MD012',
            message: 'late',
          },
        ];
      }
      if (postFixSourceFault.active && !source.includes('\t')) {
        postFixSourceFault.calls += 1;
        const report = args[3] as ((failure: unknown) => void) | undefined;
        report?.({
          source: 'markdownlint',
          phase: 'lint',
          message: 'source exploded on the post-fix text',
        });
        return [];
      }
      return actual.lintDocument(...args);
    },
  };
});

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ markdownlintEnabled: true });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

const TABBED_BODY = '# Doc\n\n\tindented with a hard tab\n';

describe('POST /api/lint/fix when the post-write re-lint throws', () => {
  test('the durable fix is reported through diagnosticsArePreFix and reLintFailure, with no singular warning field and no prefixed warnings entry', async () => {
    const folder = join(server.contentDir, 'lint-fix-relint');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'tabbed.md');
    writeFileSync(file, TABBED_BODY, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    postFixLintFault.active = true;
    postFixLintFault.calls = 0;
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/lint/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName: 'lint-fix-relint/tabbed', agentId: 'relint-fault-agent' }),
      });
      expect(res.status).toBe(200);
      const raw = (await res.json()) as Record<string, unknown>;
      expect(raw).not.toHaveProperty('warning');
      const body: LintFixResult = LintFixResultSchema.parse(raw);

      expect(postFixLintFault.calls).toBeGreaterThan(0);
      expect((body.warnings ?? []).filter(isReLintFailedWarning)).toEqual([]);
      expect(body.reLintFailure).toEqual({
        reason: 're-lint-threw',
        message: 're-lint exploded',
      });
      expect(body.diagnosticsArePreFix).toBe(true);

      expect(body.diagnostics.map((d) => d.code)).toEqual(['MD010']);
      expect(body.fixedCount).toBe(0);
      expect(readFileSync(file, 'utf-8')).not.toContain('\t');
    } finally {
      postFixLintFault.active = false;
      warn.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('POST /api/lint/fix when a source lints before the fix and fails after it', () => {
  test('reports the pre-fix diagnostics rather than counting the lost ones as fixed', async () => {
    const folder = join(server.contentDir, 'lint-fix-relint-blind');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'tabbed.md');
    writeFileSync(file, TABBED_BODY, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    postFixSourceFault.active = true;
    postFixSourceFault.calls = 0;
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/lint/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName: 'lint-fix-relint-blind/tabbed',
          agentId: 'relint-blind-agent',
        }),
      });
      expect(res.status).toBe(200);
      const body: LintFixResult = LintFixResultSchema.parse(await res.json());

      expect(postFixSourceFault.calls).toBeGreaterThan(0);
      expect(body.diagnosticsArePreFix).toBe(true);
      expect(body.fixedCount).toBe(0);
      expect(body.diagnostics.map((d) => d.code)).toEqual(['MD010']);
      expect((body.warnings ?? []).filter(isReLintFailedWarning)).toEqual([]);
      expect(body.reLintFailure?.reason).toBe('source-went-blind');
      expect(body.reLintFailure?.message).toContain('markdownlint');
    } finally {
      postFixSourceFault.active = false;
      warn.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('POST /api/lint/fix when the post-write re-lint throws with an EMPTY message', () => {
  test('still marks the diagnostics pre-fix and carries a non-empty message', async () => {
    const folder = join(server.contentDir, 'lint-fix-relint-empty');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'tabbed.md'), TABBED_BODY, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    postFixEmptyMessageFault.active = true;
    postFixEmptyMessageFault.calls = 0;
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/lint/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName: 'lint-fix-relint-empty/tabbed',
          agentId: 'relint-empty-agent',
        }),
      });
      expect(res.status).toBe(200);
      const body: LintFixResult = LintFixResultSchema.parse(await res.json());
      expect(postFixEmptyMessageFault.calls).toBeGreaterThan(0);
      expect(body.diagnosticsArePreFix).toBe(true);
      expect(body.reLintFailure?.reason).toBe('re-lint-threw');
      expect(body.reLintFailure?.message.length ?? 0).toBeGreaterThan(0);
      expect(body.fixedCount).toBe(0);
    } finally {
      postFixEmptyMessageFault.active = false;
      warn.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('POST /api/lint/fix when a source is blind BEFORE the fix and recovers after it', () => {
  test('excludes the recovered source from the comparison rather than cancelling real repairs', async () => {
    const folder = join(server.contentDir, 'lint-fix-prelint-blind');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'tabbed.md');
    writeFileSync(file, TABBED_BODY, 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    preFixSourceFault.active = true;
    preFixSourceFault.calls = 0;
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/lint/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName: 'lint-fix-prelint-blind/tabbed',
          agentId: 'prelint-blind-agent',
        }),
      });
      expect(res.status).toBe(200);
      const body: LintFixResult = LintFixResultSchema.parse(await res.json());

      expect(preFixSourceFault.calls).toBeGreaterThan(0);
      expect(body.diagnosticsArePreFix).toBeUndefined();
      expect(body.reLintFailure).toBeUndefined();
      expect(body.diagnostics.map((d) => d.source)).toEqual(['markdownlint']);
      expect(body.fixedCount).toBe(2);
      expect((body.warnings ?? []).join(' ')).toContain('markdownlint');
      expect((body.warnings ?? []).filter(isReLintFailedWarning)).toEqual([]);
    } finally {
      preFixSourceFault.active = false;
      warn.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

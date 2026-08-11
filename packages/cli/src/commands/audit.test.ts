/**
 * Unit tests for `ok audit` — target-path translation, server-first dispatch
 * (planted lock + stubbed global fetch, mirroring `sync.test.ts`), report
 * rendering over the unified plane, and exit-code semantics.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ValidationAuditResponse } from '@inkeep/open-knowledge-core';
import type { Config } from '@inkeep/open-knowledge-server';
import { RUNTIME_VERSION } from '@inkeep/open-knowledge-server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runAudit, toContentRelativeTarget } from './audit.ts';

// `runAudit` only reads `content.dir` (via `resolveContentDir`) from config.
const minimalConfig = { content: { dir: '.' } } as Config;

function payload(over: Partial<ValidationAuditResponse> = {}): ValidationAuditResponse {
  return {
    files: [],
    fileCount: 0,
    errorCount: 0,
    warningCount: 0,
    warnings: [],
    ...over,
  };
}

function diagnostic(over: Record<string, unknown> = {}) {
  return {
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
    severity: 'warning' as const,
    source: 'markdownlint',
    code: 'MD010',
    message: 'Hard tabs',
    ...over,
  };
}

// A links/dead-link finding for a missing local image, carrying the additive
// evidence the audit plane attaches, positioned at the image occurrence.
function imageDiagnostic() {
  return diagnostic({
    range: { start: { line: 5, character: 2 }, end: { line: 5, character: 2 } },
    source: 'links',
    code: 'dead-link',
    message: 'Image target "./logo.png" does not resolve to an existing file.',
    localTarget: {
      href: './logo.png',
      targetKind: 'file',
      role: 'image',
      sourceForm: 'markdown-inline',
      resolvedTarget: 'assets/logo.png',
      reason: 'no-such-file',
      resolutionMethod: 'source-relative',
    },
  });
}

function collectIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    out,
    err,
  };
}

describe('toContentRelativeTarget', () => {
  const contentDir = '/home/user/project';

  test('joins a relative path onto the invocation cwd and relativizes', () => {
    expect(toContentRelativeTarget('guides/intro.md', contentDir, contentDir)).toBe(
      'guides/intro.md',
    );
  });

  test('resolves from a nested invocation cwd', () => {
    expect(toContentRelativeTarget('intro.md', join(contentDir, 'guides'), contentDir)).toBe(
      'guides/intro.md',
    );
  });

  test('normalizes a leading-dot path', () => {
    expect(toContentRelativeTarget('./guides', contentDir, contentDir)).toBe('guides');
  });

  test('returns empty string for the content dir itself', () => {
    expect(toContentRelativeTarget('.', contentDir, contentDir)).toBe('');
  });

  test('rejects a path escaping the content dir', () => {
    expect(toContentRelativeTarget('../outside', contentDir, contentDir)).toBeNull();
    expect(toContentRelativeTarget('/etc/passwd', contentDir, contentDir)).toBeNull();
  });
});

describe('runAudit', () => {
  const origFetch = globalThis.fetch;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-audit-test-'));
    const lockDir = join(dir, '.ok', 'local');
    mkdirSync(lockDir, { recursive: true });
    // Minimal live lock: our own pid (alive), matching hostname, non-zero port.
    writeFileSync(
      join(lockDir, 'server.lock'),
      JSON.stringify({ pid: process.pid, hostname: hostname(), port: 54321 }),
    );
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  function stubFetch(
    body: unknown,
    status = 200,
  ): { urls: string[]; inits: (RequestInit | undefined)[] } {
    const urls: string[] = [];
    const inits: (RequestInit | undefined)[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(url));
      inits.push(init);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { urls, inits };
  }

  test('clean audit: GET /api/audit with cli version headers, exit 0', async () => {
    const { urls, inits } = stubFetch(payload({ fileCount: 3 }));
    const { io, out } = collectIo();

    const code = await runAudit(undefined, {}, minimalConfig, dir, dir, io);

    expect(code).toBe(0);
    expect(urls[0]).toBe('http://127.0.0.1:54321/api/audit');
    const headers = inits[0]?.headers as Record<string, string>;
    expect(headers['x-ok-client-kind']).toBe('cli');
    expect(headers['x-ok-client-runtime']).toBe(RUNTIME_VERSION);
    expect(out.join('\n')).toContain('No problems in 3 files');
  });

  test('scopes the query to the contentDir-relative target', async () => {
    const { urls } = stubFetch(payload());
    const { io } = collectIo();

    await runAudit('guides/intro.md', {}, minimalConfig, dir, dir, io);

    expect(urls[0]).toBe('http://127.0.0.1:54321/api/audit?path=guides%2Fintro.md');
  });

  test('renders the unified plane with source-tagged rows and exits 1 on problems', async () => {
    stubFetch(
      payload({
        fileCount: 2,
        errorCount: 1,
        warningCount: 1,
        files: [
          {
            file: 'a.md',
            diagnostics: [
              diagnostic(),
              diagnostic({
                severity: 'error',
                source: 'links',
                code: 'dead-link',
                message: 'Link target "missing" does not resolve to an existing document.',
              }),
            ],
          },
        ],
      }),
    );
    const { io, out } = collectIo();

    const code = await runAudit(undefined, {}, minimalConfig, dir, dir, io);

    expect(code).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('a.md');
    expect(text).toContain('markdownlint/MD010');
    expect(text).toContain('links/dead-link');
    expect(text).toContain('2 problems');
  });

  test('--errors-only ignores warning-severity findings for the exit code', async () => {
    stubFetch(
      payload({
        fileCount: 1,
        warningCount: 1,
        files: [{ file: 'a.md', diagnostics: [diagnostic()] }],
      }),
    );
    const { io } = collectIo();

    const code = await runAudit(undefined, { errorsOnly: true }, minimalConfig, dir, dir, io);

    expect(code).toBe(0);
  });

  test('--json emits the full uncapped payload', async () => {
    const body = payload({
      fileCount: 1,
      warningCount: 1,
      files: [{ file: 'a.md', diagnostics: [diagnostic()] }],
    });
    stubFetch(body);
    const { io, out } = collectIo();

    const code = await runAudit(undefined, { json: true }, minimalConfig, dir, dir, io);

    expect(code).toBe(1);
    expect(JSON.parse(out.join('\n'))).toEqual(body);
  });

  test('--json preserves local-target evidence verbatim', async () => {
    const body = payload({
      fileCount: 1,
      warningCount: 1,
      files: [{ file: 'pics.md', diagnostics: [imageDiagnostic()] }],
    });
    stubFetch(body);
    const { io, out } = collectIo();

    const code = await runAudit(undefined, { json: true }, minimalConfig, dir, dir, io);

    expect(code).toBe(1);
    // The whole plane round-trips through the parse, evidence included.
    expect(JSON.parse(out.join('\n'))).toEqual(body);
  });

  test('formatted output points at the occurrence and reads as an image break', async () => {
    stubFetch(
      payload({
        fileCount: 1,
        warningCount: 1,
        files: [{ file: 'pics.md', diagnostics: [imageDiagnostic()] }],
      }),
    );
    const { io, out } = collectIo();

    const code = await runAudit(undefined, {}, minimalConfig, dir, dir, io);

    expect(code).toBe(1);
    const text = out.join('\n');
    // 1-based location from the 0-based occurrence range — the row points at the
    // authored image, not the top of the doc.
    expect(text).toContain('6:3');
    expect(text).toContain('links/dead-link');
    expect(text).toContain('Image target "./logo.png" does not resolve to an existing file');
  });

  test('surfaces engine degradation warnings in the report', async () => {
    stubFetch(
      payload({ warnings: ['links validation unavailable: backlink index is not configured'] }),
    );
    const { io, out } = collectIo();

    const code = await runAudit(undefined, {}, minimalConfig, dir, dir, io);

    expect(code).toBe(0);
    expect(out.join('\n')).toContain('links validation unavailable');
  });

  test('errors with `ok start` guidance when no server lock is live', async () => {
    rmSync(join(dir, '.ok', 'local', 'server.lock'));
    const { io, err } = collectIo();

    const code = await runAudit(undefined, {}, minimalConfig, dir, dir, io);

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('ok start');
    expect(err.join('\n')).toContain('ok lint');
  });

  test('rejects a target outside the content dir before dialing the server', async () => {
    const { urls } = stubFetch(payload());
    const { io, err } = collectIo();

    const code = await runAudit('../outside', {}, minimalConfig, dir, dir, io);

    expect(code).toBe(1);
    expect(urls).toHaveLength(0);
    expect(err.join('\n')).toContain('outside the content directory');
  });

  test('surfaces the problem+json title on a non-OK response', async () => {
    stubFetch({ title: 'Invalid path.' }, 400);
    const { io, err } = collectIo();

    const code = await runAudit(undefined, {}, minimalConfig, dir, dir, io);

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('Invalid path.');
  });

  test('errors on an unexpected response shape', async () => {
    stubFetch({ nonsense: true });
    const { io, err } = collectIo();

    const code = await runAudit(undefined, {}, minimalConfig, dir, dir, io);

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('unexpected response shape');
  });
});

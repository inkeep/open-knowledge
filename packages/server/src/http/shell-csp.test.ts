import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createShellHeaderSetter } from './shell-csp.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync), readdirSync: vi.fn(fs.readdirSync) };
});

function scriptHash(source: string): string {
  return `'sha256-${createHash('sha256').update(source).digest('base64')}'`;
}

function denied(): never {
  throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
}

const SHELL_SCRIPT = 'window.shellBooted = true;';

describe('createShellHeaderSetter', () => {
  let dist: string;

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'ok-shell-csp-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(
      join(dist, 'index.html'),
      `<!doctype html><script>${SHELL_SCRIPT}</script><script type="module" src="./assets/app.js"></script>`,
    );
    writeFileSync(join(dist, 'assets', 'app.js'), 'export {};');
    writeFileSync(
      join(dist, 'assets', 'preview-frame.html'),
      "<!doctype html><script>addEventListener('message', () => {});</script>",
    );
  });

  afterEach(() => {
    vi.mocked(readFileSync).mockReset();
    vi.mocked(readdirSync).mockReset();
    rmSync(dist, { recursive: true, force: true });
  });

  function serve(setHeaders: ReturnType<typeof createShellHeaderSetter>, file: string) {
    const res = new ServerResponse(new IncomingMessage(new Socket()));
    setHeaders(res, '/the-request-path-is-not-used', statSync(join(dist, file)));
    return res.getHeader('content-security-policy');
  }

  test('each served document gets its own policy, and other files get none', () => {
    const setHeaders = createShellHeaderSetter(dist);
    expect(serve(setHeaders, 'index.html')).toContain(scriptHash(SHELL_SCRIPT));
    expect(serve(setHeaders, 'assets/preview-frame.html')).toBe(
      "sandbox allow-scripts; frame-ancestors 'self'",
    );
    expect(serve(setHeaders, 'assets/app.js')).toBeUndefined();
  });

  function setFolderTimes(time: Date) {
    for (const folder of [dist, join(dist, 'assets')]) utimesSync(folder, time, time);
  }

  test('a document added to a subfolder after the first scan gets its policy', () => {
    setFolderTimes(new Date('2020-01-01T00:00:00Z'));
    const setHeaders = createShellHeaderSetter(dist);
    serve(setHeaders, 'index.html');
    writeFileSync(join(dist, 'assets', 'late.html'), '<script>window.late = true;</script>');
    const assetsTouched = new Date('2021-01-01T00:00:00Z');
    utimesSync(join(dist, 'assets'), assetsTouched, assetsTouched);
    expect(serve(setHeaders, 'assets/late.html')).toContain(scriptHash('window.late = true;'));
  });

  test('a listing of recently changed folders is taken again even if no mtime moves', () => {
    const recent = new Date(Date.now() - 500);
    setFolderTimes(recent);
    const setHeaders = createShellHeaderSetter(dist);
    serve(setHeaders, 'index.html');
    writeFileSync(join(dist, 'assets', 'late.html'), '<script>window.late = true;</script>');
    setFolderTimes(recent);
    expect(serve(setHeaders, 'assets/late.html')).toContain(scriptHash('window.late = true;'));
  });

  test('a served file that matches two documents blocks inline scripts', () => {
    linkSync(join(dist, 'index.html'), join(dist, 'assets', 'index-copy.html'));
    const policy = serve(createShellHeaderSetter(dist), 'index.html');
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain('sha256-');
  });

  test('a failed document read blocks inline scripts once and is not remembered', () => {
    const setHeaders = createShellHeaderSetter(dist);
    vi.mocked(readFileSync).mockImplementationOnce(denied);
    const failed = serve(setHeaders, 'index.html');
    expect(failed).toContain("script-src 'self'");
    expect(failed).not.toContain('sha256-');
    expect(serve(setHeaders, 'index.html')).toContain(scriptHash(SHELL_SCRIPT));
  });

  test('a failed scan blocks inline scripts once and is not remembered', () => {
    const setHeaders = createShellHeaderSetter(dist);
    vi.mocked(readdirSync).mockImplementationOnce(denied);
    const failed = serve(setHeaders, 'index.html');
    expect(failed).toContain("script-src 'self'");
    expect(failed).not.toContain('sha256-');
    expect(serve(setHeaders, 'index.html')).toContain(scriptHash(SHELL_SCRIPT));
  });
});

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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAppShellPolicies } from './app-shell-csp.ts';

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

describe('createAppShellPolicies', () => {
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
    onFailure.mockReset();
    rmSync(dist, { recursive: true, force: true });
  });

  const onFailure = vi.fn();

  function policies() {
    return createAppShellPolicies(dist, onFailure);
  }

  function serve(policyFor: ReturnType<typeof createAppShellPolicies>, file: string) {
    const path = join(dist, file);
    return policyFor({ file: path, stats: statSync(path) });
  }

  test('each served document gets its own policy, and other files get none', () => {
    const policyFor = policies();
    expect(serve(policyFor, 'index.html')).toContain(scriptHash(SHELL_SCRIPT));
    expect(serve(policyFor, 'assets/preview-frame.html')).toBe(
      "sandbox allow-scripts; frame-ancestors 'self'",
    );
    expect(serve(policyFor, 'assets/app.js')).toBeUndefined();
  });

  function setFolderTimes(time: Date) {
    for (const folder of [dist, join(dist, 'assets')]) utimesSync(folder, time, time);
  }

  test('a document added to a subfolder after the first scan gets its policy', () => {
    setFolderTimes(new Date('2020-01-01T00:00:00Z'));
    const policyFor = policies();
    serve(policyFor, 'index.html');
    writeFileSync(join(dist, 'assets', 'late.html'), '<script>window.late = true;</script>');
    const assetsTouched = new Date('2021-01-01T00:00:00Z');
    utimesSync(join(dist, 'assets'), assetsTouched, assetsTouched);
    expect(serve(policyFor, 'assets/late.html')).toContain(scriptHash('window.late = true;'));
  });

  test('a listing of recently changed folders is taken again even if no mtime moves', () => {
    const recent = new Date(Date.now() - 500);
    setFolderTimes(recent);
    const policyFor = policies();
    serve(policyFor, 'index.html');
    writeFileSync(join(dist, 'assets', 'late.html'), '<script>window.late = true;</script>');
    setFolderTimes(recent);
    expect(serve(policyFor, 'assets/late.html')).toContain(scriptHash('window.late = true;'));
  });

  test('a served file that matches two documents blocks inline scripts', () => {
    linkSync(join(dist, 'index.html'), join(dist, 'assets', 'index-copy.html'));
    const policy = serve(policies(), 'index.html');
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain('sha256-');
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ file: join(dist, 'index.html') }),
      expect.any(String),
    );
  });

  test('a failed document read blocks inline scripts once and is not remembered', () => {
    const policyFor = policies();
    vi.mocked(readFileSync).mockImplementationOnce(denied);
    const failed = serve(policyFor, 'index.html');
    expect(failed).toContain("script-src 'self'");
    expect(failed).not.toContain('sha256-');
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(serve(policyFor, 'index.html')).toContain(scriptHash(SHELL_SCRIPT));
  });

  test('a failed scan blocks inline scripts once and is not remembered', () => {
    const policyFor = policies();
    vi.mocked(readdirSync).mockImplementationOnce(denied);
    const failed = serve(policyFor, 'index.html');
    expect(failed).toContain("script-src 'self'");
    expect(failed).not.toContain('sha256-');
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(serve(policyFor, 'index.html')).toContain(scriptHash(SHELL_SCRIPT));
  });
});

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { DEV_HARNESS_SENTINEL } from '../../scripts/check-dev-harness-absent.mjs';

const APP_ROOT = join(import.meta.dirname, '..', '..');
const GATE = join(APP_ROOT, 'scripts', 'check-dev-harness-absent.mjs');

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dev-harness-gate-'));
  dirs.push(dir);
  return dir;
}

function runGate(distDir: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [GATE, '--dist', distDir], { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

function writeBuild(contents: Record<string, string>): string {
  const dist = tmp();
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><body></body>');
  for (const [name, body] of Object.entries(contents)) {
    writeFileSync(join(dist, 'assets', name), body);
  }
  return dist;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('the emitted-artifact scanner', () => {
  test('fails on a chunk carrying the harness global, and names it', () => {
    const dist = writeBuild({
      'index-a1b2c3.js': 'const a=1;export{a};',
      'AgentThreadClientBinder-d4e5f6.js': `window.${DEV_HARNESS_SENTINEL}=h;`,
    });

    const { status, stderr } = runGate(dist);

    expect(status).toBe(1);
    expect(stderr).toContain('AgentThreadClientBinder-d4e5f6.js');
    expect(stderr).not.toContain('index-a1b2c3.js');
  });

  test('passes the same build once the leak is gone', () => {
    const dist = writeBuild({
      'index-a1b2c3.js': 'const a=1;export{a};',
      'AgentThreadClientBinder-d4e5f6.js': 'const b=2;export{b};',
    });

    expect(runGate(dist).status).toBe(0);
  });

  test('fails when there is no build to read', () => {
    const { status, stderr } = runGate(join(tmp(), 'never-built'));

    expect(status).toBe(1);
    expect(stderr).toContain('no build at');
  });

  test('fails when the walk turns up nothing to read', () => {
    const dist = tmp();
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'assets', 'inter-latin.woff2'), 'not text');

    const { status, stderr } = runGate(dist);

    expect(status).toBe(1);
    expect(stderr).toContain('nothing to scan');
  });
});

describe('the gate runs when the artifact is produced', () => {
  const scripts = (
    JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  test('the production build invokes it', () => {
    expect(scripts.build).toContain('check:no-dev-harness');
    expect(scripts['check:no-dev-harness']).toContain('check-dev-harness-absent.mjs');
  });

  test('it runs after the bundler, not before', () => {
    expect(scripts.build.indexOf('vite build')).toBeLessThan(
      scripts.build.indexOf('check:no-dev-harness'),
    );
  });
});

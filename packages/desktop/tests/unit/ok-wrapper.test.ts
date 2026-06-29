import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';

const WRAPPER = join(import.meta.dir, '..', '..', 'resources', 'cli', 'bin', 'ok.sh');

describe('ok.sh wrapper', () => {
  test('is committed with executable bit set', () => {
    expect(() => accessSync(WRAPPER, constants.X_OK)).not.toThrow();
  });

  test('missing bundle emits two-line stderr and exits 69', () => {
    const result = spawnSync(WRAPPER, [], {
      env: { ...process.env, APP_BUNDLE_DIR: '/nonexistent/fake.app' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(69);
    const lines = result.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('OpenKnowledge has been removed. Reinstall from the OpenKnowledge DMG.');
    const parsed = JSON.parse(lines[1] ?? '');
    expect(parsed).toEqual({
      error: 'ok-bundle-missing',
      hint: 'OpenKnowledge app appears to have been removed. Reinstall from the DMG, or remove OK entries from your MCP config and rerun ok init.',
    });
  });

  test('missing Electron binary but present CLI also diagnoses missing-bundle', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const fixture = mkdtempSync(join(tmpdir(), 'ok-wrapper-'));
    const appRoot = join(fixture, 'OpenKnowledge.app');
    mkdirSync(join(appRoot, 'Contents', 'Resources', 'cli', 'dist'), { recursive: true });
    writeFileSync(join(appRoot, 'Contents', 'Resources', 'cli', 'dist', 'cli.mjs'), '// stub');

    const result = spawnSync(WRAPPER, [], {
      env: { ...process.env, APP_BUNDLE_DIR: appRoot },
      encoding: 'utf8',
    });
    expect(result.status).toBe(69);
    expect(result.stderr).toContain('ok-bundle-missing');
  });

  test('Pass 0 Major #10: empty APP_PATH branch emits structured stderr + exit 69', async () => {
    const { mkdtempSync, copyFileSync, chmodSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'ok-wrapper-empty-'));
    const wrapperCopy = join(dir, 'ok.sh');
    copyFileSync(WRAPPER, wrapperCopy);
    chmodSync(wrapperCopy, 0o755);

    const result = spawnSync(wrapperCopy, [], {
      env: { ...process.env, APP_BUNDLE_DIR: '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(69);
    const lines = result.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      'OpenKnowledge CLI cannot find its app bundle. Reinstall from the OpenKnowledge DMG.',
    );
    const parsed = JSON.parse(lines[1] ?? '');
    expect(parsed.error).toBe('ok-wrapper-resolution-failed');
    expect(parsed.hint).toContain('could not resolve its enclosing .app bundle');
    expect(parsed.source).toBe(wrapperCopy);
  });

  test('NODE_OPTIONS is rescoped to OK_NODE_OPTIONS before exec (quoted, per Pass 0 Minor #15)', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const script = readFileSync(WRAPPER, 'utf8');
    expect(script).toContain('export OK_NODE_OPTIONS="$NODE_OPTIONS"');
    expect(script).toContain('unset NODE_OPTIONS');
    const rescopeIdx = script.indexOf('export OK_NODE_OPTIONS="$NODE_OPTIONS"');
    const unsetIdx = script.indexOf('unset NODE_OPTIONS');
    expect(rescopeIdx).toBeGreaterThan(0);
    expect(unsetIdx).toBeGreaterThan(rescopeIdx);
    expect(script).not.toContain('export OK_NODE_OPTIONS=$NODE_OPTIONS\n');
  });
});

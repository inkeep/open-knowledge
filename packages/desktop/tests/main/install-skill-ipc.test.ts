/**
 * Unit tests for the Electron IPC handler `handleBuildAndOpen`. Covers the
 * install-state gate, force bypass, legacy-sidecar migration, and post-build
 * state-write — the four behaviors the renderer's "Open in Cowork" click
 * depends on.
 *
 * Spec: (two write sites).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTargetVersion, writeTargetVersion } from '@inkeep/open-knowledge-server';
import { handleBuildAndOpen } from '../../src/main/ipc/install-skill.ts';

interface FakeApp {
  getPath(name: 'downloads'): string;
}

interface FakeShell {
  openPath: ReturnType<typeof mock>;
}

function makeFakeApp(downloadsDir: string): FakeApp {
  return {
    getPath(name: 'downloads'): string {
      if (name !== 'downloads') {
        throw new Error(`Unexpected path key: ${name}`);
      }
      return downloadsDir;
    },
  };
}

function makeFakeShell(openResult: string | Error = ''): FakeShell {
  return {
    openPath: mock(async () => {
      if (openResult instanceof Error) throw openResult;
      return openResult;
    }),
  };
}

let home: string;
let downloads: string;

async function readServerVersion(): Promise<string> {
  const url = new URL('../../../server/package.json', import.meta.url);
  const raw = readFileSync(url, 'utf-8');
  return (JSON.parse(raw) as { version: string }).version;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ok-handle-build-and-open-'));
  downloads = join(home, 'Downloads');
  mkdirSync(downloads, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('handleBuildAndOpen — install-state gate', () => {
  test('recorded claude-cowork matches current version → skipped: true; shell.openPath NOT called', async () => {
    const currentVersion = await readServerVersion();
    await writeTargetVersion(home, 'claude-cowork', currentVersion);
    const shell = makeFakeShell();

    const result = await handleBuildAndOpen({
      app: makeFakeApp(downloads),
      shell,
      home,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skipped).toBe(true);
      if (result.skipped) {
        expect(result.version).toBe(currentVersion);
        expect(typeof result.recordedAt).toBe('string');
      }
    }
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  test('no recorded version → builds, opens, writes target', async () => {
    const currentVersion = await readServerVersion();
    const shell = makeFakeShell();

    const result = await handleBuildAndOpen({
      app: makeFakeApp(downloads),
      shell,
      home,
    });

    expect(result.ok).toBe(true);
    if (result.ok && !result.skipped) {
      expect(result.path).toContain('openknowledge.skill');
    }
    expect(shell.openPath).toHaveBeenCalledTimes(1);
    // State file populated with the freshly-built skill version.
    expect(await readTargetVersion(home, 'claude-cowork')).toBe(currentVersion);
  });

  test('recorded version DIFFERENT from current → builds, opens, overwrites state', async () => {
    const currentVersion = await readServerVersion();
    await writeTargetVersion(home, 'claude-cowork', '0.0.1-stale');
    const shell = makeFakeShell();

    const result = await handleBuildAndOpen({
      app: makeFakeApp(downloads),
      shell,
      home,
    });

    expect(result.ok).toBe(true);
    if (result.ok && !result.skipped) {
      expect(result.path).toContain('openknowledge.skill');
    }
    expect(shell.openPath).toHaveBeenCalledTimes(1);
    expect(await readTargetVersion(home, 'claude-cowork')).toBe(currentVersion);
  });
});

describe('handleBuildAndOpen — force bypass (FR12)', () => {
  test('force=true bypasses gate even when recorded matches current', async () => {
    const currentVersion = await readServerVersion();
    await writeTargetVersion(home, 'claude-cowork', currentVersion);
    const shell = makeFakeShell();

    const result = await handleBuildAndOpen({
      app: makeFakeApp(downloads),
      shell,
      home,
      force: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Force path proceeds to build → not skipped.
      expect(result.skipped).not.toBe(true);
    }
    expect(shell.openPath).toHaveBeenCalledTimes(1);
    // State file updated with a fresh recordedAt.
    expect(await readTargetVersion(home, 'claude-cowork')).toBe(currentVersion);
  });
});

describe('handleBuildAndOpen — handoff failure', () => {
  test('shell.openPath returns non-empty error → ok:false reason=open-failed; state still written', async () => {
    const currentVersion = await readServerVersion();
    const shell = makeFakeShell('Error: no default handler for .skill');

    const result = await handleBuildAndOpen({
      app: makeFakeApp(downloads),
      shell,
      home,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('open-failed');
      expect(result.message).toContain('no default handler');
    }
    // State file populated even though the OS handoff failed — the bundle
    // is on disk and a future click should skip the rebuild.
    expect(await readTargetVersion(home, 'claude-cowork')).toBe(currentVersion);
  });

  test('app.getPath throws → ok:false reason=no-downloads-dir', async () => {
    const shell = makeFakeShell();
    const brokenApp: FakeApp = {
      getPath() {
        throw new Error('downloads dir unavailable in test env');
      },
    };

    const result = await handleBuildAndOpen({ app: brokenApp, shell, home });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no-downloads-dir');
    }
    expect(shell.openPath).not.toHaveBeenCalled();
  });
});

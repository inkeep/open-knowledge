import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  BASE16_SLOTS,
  REMOVED_KEYS,
  resolveThemePlugin,
  type WriteScope,
} from '@inkeep/open-knowledge-core';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { stringify } from 'yaml';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let server: TestServer;
let homeDir: string;

beforeAll(async () => {
  homeDir = `${process.env.TMPDIR ?? '/tmp'}/ok-diag-home-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(homeDir, { recursive: true });
  server = await createTestServer({ configHomedirOverride: homeDir });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
  rmSync(homeDir, { recursive: true, force: true });
});

function scopeFile(scope: WriteScope): string {
  return resolveConfigPath(scope, server.contentDir, homeDir);
}

function writeScope(scope: WriteScope, value: Record<string, unknown>): void {
  const file = scopeFile(scope);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringify(value), 'utf-8');
}

function redirectFor(dottedPath: string): string {
  const entry = REMOVED_KEYS.find((k) => k.path.join('.') === dottedPath);
  if (!entry) throw new Error(`fixture key ${dottedPath} missing from registry`);
  return entry.redirect;
}

afterEach(() => {
  for (const scope of ['user', 'project', 'project-local'] as const) {
    rmSync(scopeFile(scope), { force: true });
  }
});

const url = () => `http://127.0.0.1:${server.port}/api/config/diagnostics`;

interface DiagnosticItem {
  code: string;
  scope: string;
  file: string;
  path?: string[];
  redirect?: string;
}

describe('GET /api/config/diagnostics', () => {
  test('reports each of the three config layers with scope, file, key path, code, and redirect', async () => {
    writeScope('user', {
      content: { dir: 'USER_REAL_DIR' },
      server: { host: 'user-secret-host.internal' },
    });
    writeScope('project', {
      content: { dir: 'PROJECT_REAL_DIR' },
      folders: ['project-secret-folder'],
    });
    writeScope('project-local', {
      content: { dir: 'LOCAL_REAL_DIR' },
      autoSync: { mode: 'full' },
      appearance: { sidebar: { showAllFiles: false } },
    });

    const res = await fetch(url());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { diagnostics: DiagnosticItem[] };

    const byScope = new Map(body.diagnostics.map((d) => [d.scope, d]));
    expect(byScope.get('user')).toEqual({
      code: 'REMOVED_KEY',
      scope: 'user',
      file: scopeFile('user'),
      path: ['server', 'host'],
      redirect: redirectFor('server.host'),
    });
    expect(byScope.get('project')).toEqual({
      code: 'REMOVED_KEY',
      scope: 'project',
      file: scopeFile('project'),
      path: ['folders'],
      redirect: redirectFor('folders'),
    });
    expect(byScope.get('project-local')).toEqual({
      code: 'REMOVED_KEY',
      scope: 'project-local',
      file: scopeFile('project-local'),
      path: ['appearance', 'sidebar', 'showAllFiles'],
      redirect: redirectFor('appearance.sidebar.showAllFiles'),
    });
  });

  test('the response body carries Cache-Control: no-store and no raw config values', async () => {
    writeScope('user', {
      content: { dir: 'USER_REAL_DIR' },
      server: { host: 'user-secret-host.internal' },
    });
    writeScope('project', {
      content: { dir: 'PROJECT_REAL_DIR' },
      folders: ['project-secret-folder'],
    });
    writeScope('project-local', {
      content: { dir: 'LOCAL_REAL_DIR' },
      autoSync: { mode: 'full' },
      appearance: { sidebar: { showAllFiles: false } },
    });

    const res = await fetch(url());
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    for (const secret of [
      'USER_REAL_DIR',
      'PROJECT_REAL_DIR',
      'LOCAL_REAL_DIR',
      'user-secret-host.internal',
      'project-secret-folder',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  test('a stale key removed from disk is omitted on the very next request without a restart', async () => {
    writeScope('project-local', {
      appearance: { sidebar: { showAllFiles: false } },
      mcp: { autoStart: false },
    });

    const first = (await (await fetch(url())).json()) as { diagnostics: DiagnosticItem[] };
    const firstPaths = first.diagnostics.map((d) => d.path?.join('.')).sort();
    expect(firstPaths).toEqual(['appearance.sidebar.showAllFiles', 'mcp.autoStart']);

    writeScope('project-local', { mcp: { autoStart: false } });

    const second = (await (await fetch(url())).json()) as { diagnostics: DiagnosticItem[] };
    expect(second.diagnostics.map((d) => d.path?.join('.'))).toEqual(['mcp.autoStart']);
  });

  test('deleting an assigned saved theme preserves unrelated user preferences', async () => {
    const themeName = 'assigned-personal';
    const themeId = `saved-${themeName}`;
    const palette = Object.fromEntries(
      BASE16_SLOTS.map((slot, index) => {
        const byte = (index * 16).toString(16).padStart(2, '0');
        return [slot, `#${byte}${byte}${byte}`];
      }),
    );
    const created = await fetch(`http://127.0.0.1:${server.port}/api/saved-theme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: themeName,
        scheme: { name: 'Assigned personal', variant: 'dark', palette },
      }),
    });
    expect(created.status).toBe(201);

    writeScope('user', {
      editor: { wordWrap: false },
      appearance: {
        theme: 'dark',
        colorThemeLight: themeId,
        colorThemeDark: 'dracula',
      },
    });

    const deleted = await fetch(`http://127.0.0.1:${server.port}/api/saved-theme?id=${themeId}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect((await deleted.json()) as unknown).toMatchObject({
      existed: true,
      filename: `${themeName}.yaml`,
    });

    const configFile = scopeFile('user');
    const readBack = readConfigSafely({ absPath: configFile, warn: () => {} });
    expect(readBack.valid).toBe(true);
    expect(readBack).not.toHaveProperty('sidelinedTo');
    expect(readBack.value).toMatchObject({
      editor: { wordWrap: false },
      appearance: {
        theme: 'dark',
        colorThemeLight: themeId,
        colorThemeDark: 'dracula',
      },
    });
    expect(resolveThemePlugin(themeId).id).toBe('default');
    expect(readdirSync(dirname(configFile)).filter((file) => file.includes('.invalid-'))).toEqual(
      [],
    );
  });

  test('no config files present → 200 with an empty diagnostics list', async () => {
    const res = await fetch(url());
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ diagnostics: [] });
  });

  test('a non-GET/HEAD method is rejected 405 with an Allow header', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(url(), { method });
      expect(res.status).toBe(405);
      const allow = res.headers.get('allow') ?? '';
      expect(allow).toContain('GET');
      expect(allow).toContain('HEAD');
    }
  });

  test('HEAD returns 200 with no-store and an empty body', async () => {
    writeScope('project-local', { appearance: { sidebar: { showAllFiles: false } } });
    const res = await fetch(url(), { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
  });
});

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE16_SLOTS } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  deleteSavedTheme,
  fetchSavedThemes,
  saveSavedTheme,
} from '../../src/lib/saved-themes-client';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let homeDir: string;
let server: TestServer;

function schemeYaml(name: string): string {
  const slots = BASE16_SLOTS.map(
    (slot, index) => `  ${slot}: "#${(index * 16).toString(16).padStart(2, '0').repeat(3)}"`,
  ).join('\n');
  return `name: "${name}"\nvariant: "light"\npalette:\n${slots}\n`;
}

function scheme(name: string) {
  return {
    name,
    variant: 'dark' as const,
    palette: Object.fromEntries(
      BASE16_SLOTS.map((slot, index) => {
        const byte = (index * 16).toString(16).padStart(2, '0');
        return [slot, `#${byte}${byte}${byte}`];
      }),
    ),
  };
}

beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'ok-saved-themes-client-'));
  const dir = join(homeDir, '.ok', 'themes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'day.yaml'), schemeYaml('Day'));
  writeFileSync(join(dir, 'broken.yaml'), 'name: "Broken"\npalette:\n  base00: "#000000"\n');
  server = await createTestServer({ configHomedirOverride: homeDir });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('saved-theme server-to-app list', () => {
  test('adapts the real list response without dropping warning entries', async () => {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const request = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);

    const result = await fetchSavedThemes({ request });

    expect(result.themes.at(-1)).toMatchObject({ id: 'saved-day', label: 'Day', kind: 'light' });
    expect(result.warnings).toEqual([
      { filename: 'broken.yaml', id: 'saved-broken', code: 'missing-slots' },
    ]);
  });

  test('hard-deletes through the client without retaining a copy and recreates the intact palette', async () => {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const request = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);
    const recoverable = scheme('Recoverable');
    const dotOkEntriesBefore = readdirSync(join(homeDir, '.ok')).sort();

    expect(
      await saveSavedTheme({ name: 'recoverable', scheme: recoverable }, { request }),
    ).toMatchObject({ ok: true, id: 'saved-recoverable' });

    expect(await deleteSavedTheme('saved-recoverable', { request })).toEqual({
      ok: true,
      existed: true,
      filename: 'recoverable.yaml',
      scheme: recoverable,
    });
    expect(readdirSync(join(homeDir, '.ok', 'themes')).sort()).toEqual(['broken.yaml', 'day.yaml']);
    expect(readdirSync(join(homeDir, '.ok')).sort()).toEqual(dotOkEntriesBefore);
    expect(
      (await fetchSavedThemes({ request })).themes.some(
        (theme) => theme.id === 'saved-recoverable',
      ),
    ).toBe(false);

    expect(
      await saveSavedTheme({ name: 'recoverable', scheme: recoverable }, { request }),
    ).toMatchObject({ ok: true, id: 'saved-recoverable' });
    expect(
      (await fetchSavedThemes({ request })).themes.find((theme) => theme.id === 'saved-recoverable')
        ?.scheme,
    ).toEqual(recoverable);
  });
});

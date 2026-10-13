import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { DEV_HARNESS_SENTINEL } from '../../scripts/check-dev-harness-absent.mjs';
import {
  REQUIRED_FIXTURE_ENTRY_NAMES,
  WORKER_SERVER_BUDGET_TOTAL_MS,
} from './_helpers/fixtures.ts';
import type { PrebuiltDevApp } from './_helpers/prebuilt/prebuilt-dev-app.ts';
import { preparePrebuiltDevApp } from './_helpers/prebuilt/prebuilt-dev-build.ts';
import { launchOwnedWorkerServer } from './_helpers/reuse/owned-dev-server.ts';
import type { OwnedServer } from './_helpers/reuse/server-supervisor.ts';
import { APP_PACKAGE_ROOT } from './_helpers/seed-key.ts';

type PrebuiltServing = { readonly app: PrebuiltDevApp; readonly server: OwnedServer };

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const test = base.extend<object, { prebuiltApp: PrebuiltDevApp; prebuilt: PrebuiltServing }>({
  prebuiltApp: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture contract
    async ({}, use) => {
      await use(await preparePrebuiltDevApp());
    },
    { scope: 'worker', timeout: WORKER_SERVER_BUDGET_TOTAL_MS },
  ],
  prebuilt: [
    async ({ prebuiltApp: app }, use) => {
      const server = await launchOwnedWorkerServer({
        label: 'prebuilt-serving',
        workerServerEnv: {},
        serving: { kind: 'prebuilt', outputDir: app.outputDir },
      });
      try {
        await use({ app, server });
      } finally {
        await server.release();
      }
    },
    { scope: 'worker', timeout: WORKER_SERVER_BUDGET_TOTAL_MS },
  ],
});

test.describe.configure({ mode: 'default' });

function firstFile(dir: string, extension: string): string {
  const found = readdirSync(dir, { recursive: true, encoding: 'utf8' }).find((name) =>
    name.endsWith(extension),
  );
  if (found === undefined) throw new Error(`no ${extension} under ${dir}`);
  return found.split(sep).join('/');
}

test('the prebuilt DEV app is built outside the shipped output and keeps the DEV hooks the production gate rejects', ({
  prebuilt,
}) => {
  expect(
    relative(join(APP_PACKAGE_ROOT, 'node_modules', '.cache'), prebuilt.app.distDir),
  ).not.toMatch(/^\.\./);

  const gate = spawnSync(
    process.execPath,
    [
      join(APP_PACKAGE_ROOT, 'scripts', 'check-dev-harness-absent.mjs'),
      '--dist',
      prebuilt.app.distDir,
    ],
    { encoding: 'utf8' },
  );

  expect(gate.status).toBe(1);
  expect(gate.stderr).toContain(`'${DEV_HARNESS_SENTINEL}' reached the production build`);
});

test('the prebuilt DEV app serves its own fonts and Excalidraw assets and renders the editor', async ({
  prebuilt,
  page,
  request,
}) => {
  const { app, server } = prebuilt;
  const font = await request.get(
    `${server.baseURL}/assets/${firstFile(join(app.distDir, 'assets'), '.woff2')}`,
  );
  expect(font.status()).toBe(200);
  expect(font.headers()['content-type']).toBe('font/woff2');
  const excalidraw = await request.get(
    `${server.baseURL}/excalidraw-assets/${firstFile(join(app.distDir, 'excalidraw-assets'), '.woff2')}`,
  );
  expect(excalidraw.status()).toBe(200);
  const icon = await request.get(`${server.baseURL}/favicon.svg`);
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toBe('image/svg+xml');

  const failed: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`${server.baseURL}/`);
  await expect(
    page.getByRole('treeitem', { name: REQUIRED_FIXTURE_ENTRY_NAMES[0], exact: true }),
  ).toBeVisible();
  expect(failed).toEqual([]);
});

test('user assets keep their disposition and a missing asset is a 404 rather than the app shell', async ({
  prebuilt,
  request,
}) => {
  const { server } = prebuilt;
  writeFileSync(join(server.contentDir, 'serving-smoke.png'), PNG_1X1);
  writeFileSync(join(server.contentDir, 'serving-smoke.zip'), Buffer.from('PK\u0005\u0006'));

  const inline = await request.get(`${server.baseURL}/serving-smoke.png`);
  expect(inline.status()).toBe(200);
  expect(inline.headers()['content-disposition']).toBe('inline');
  const attachment = await request.get(`${server.baseURL}/serving-smoke.zip`);
  expect(attachment.status()).toBe(200);
  expect(attachment.headers()['content-disposition']).toBe('attachment');

  for (const missing of [
    '/missing-asset.png',
    '/assets/missing-font.woff2',
    '/assets/missing-chunk.js',
  ]) {
    const response = await request.get(`${server.baseURL}${missing}`);
    expect(response.status(), missing).toBe(404);
    expect(await response.text(), missing).not.toContain('<div id="root">');
  }

  const route = await request.get(`${server.baseURL}/some/folder/page`);
  expect(route.status()).toBe(200);
  expect(await route.text()).toContain('<div id="root">');
});

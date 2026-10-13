import { E2E_PAGE_MODULES_SOURCE } from '../../src/build/prebuilt-dev-contract.ts';
import { TEST_LOOP_MARKERS_PATH } from '../../src/build/test-loop-marker-contract.ts';
import type * as PageModules from '../../src/test-utils/e2e-page-modules.ts';
import { expect, servedModuleUrl, test } from './_helpers';
import { expectedLoopMarker, type LoopMarkerClass } from './_helpers/loop-markers.ts';

function expectedMarker(markerClass: LoopMarkerClass): string {
  const { onDisk, instrument } = expectedLoopMarker(markerClass);
  if (instrument !== undefined) {
    expect(onDisk, `the ${markerClass} marker source holds the instrument's edit`).toBe(instrument);
  }
  return onDisk;
}

async function servedTestServerMarkers(baseURL: string | undefined): Promise<unknown> {
  const response = await fetch(new URL(TEST_LOOP_MARKERS_PATH, baseURL));
  expect(response.status).toBe(200);
  return response.json();
}

test('the served app module carries the app marker its source holds', async ({ page }) => {
  const expected = expectedMarker('app');
  const pageModules = servedModuleUrl(E2E_PAGE_MODULES_SOURCE);
  await expect
    .poll(async () => {
      await page.goto('/');
      return page.evaluate(async (moduleUrl) => {
        const { TEST_LOOP_APP_MARKER }: typeof PageModules = await import(moduleUrl);
        return TEST_LOOP_APP_MARKER;
      }, pageModules);
    })
    .toBe(expected);
});

test('the test server reports the server marker its source holds', async ({ baseURL }) => {
  const expected = expectedMarker('server');
  expect(await servedTestServerMarkers(baseURL)).toMatchObject({ server: expected });
});

test('the test server reports the core marker its source holds', async ({ baseURL }) => {
  const expected = expectedMarker('core');
  expect(await servedTestServerMarkers(baseURL)).toMatchObject({ core: expected });
});

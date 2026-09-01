import type { Page } from '@playwright/test';

/**
 * A real 300x200 PNG, inline. Solid slate so a failure screenshot or video
 * still reads as "the stub loaded" rather than as a blank frame.
 *
 * Deliberately not the 1x1 from `upload-fixtures`: these tests click the
 * rendered image, and an `<img>` with no width/height attributes lays out at
 * its intrinsic size — a 1x1 click target lands on whatever is underneath.
 */
const STUB_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAASwAAADICAIAAADdvUsCAAABsUlEQVR42u3TQQ0AAAjEsBOLBFxgGhk8aFIFS5bqAQ5FAjAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQTKgCmBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAgmVAFMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBBMCJgQTAiaEnxboihYsGmarVAAAAABJRU5ErkJggg==';

/** Hosts whose images tests embed to get a genuinely-decoded raster. */
const REMOTE_IMAGE_HOSTS = ['picsum.photos'];

/**
 * Serve a valid PNG for every remote image host a test embeds, so the assertion
 * under test does not depend on a third-party CDN.
 *
 * Both observed CI failure shapes came from that dependency, and both look like
 * product bugs at the assertion site:
 *   - no bytes: the `<img>` stays `opacity-0` and never becomes visible;
 *   - bad bytes: the request completes so `loaded` flips to `opacity-100`,
 *     then `decode()` rejects and `LoadingImage` sets `hidden` — correct
 *     component behaviour for a broken image, and still never visible.
 *
 * Call before navigating; routes are per-page and released with the context.
 */
export async function stubRemoteImages(page: Page): Promise<void> {
  const body = Buffer.from(STUB_PNG_BASE64, 'base64');
  for (const host of REMOTE_IMAGE_HOSTS) {
    await page.route(`**://${host}/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'cache-control': 'no-store' },
        body,
      }),
    );
  }
}

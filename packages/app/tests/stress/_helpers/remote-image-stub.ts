import type { Page } from '@playwright/test';

const STUB_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAASwAAADICAIAAADdvUsCAAABsUlEQVR42u3TQQ0AAAjEsBOLBFxgGhk8aFIFS5bqAQ5FAjAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQMCGYEDAhmBAwIZgQTKgCmBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAiYEEwImBBMCJgQTAgmVAFMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBEwIJgRMCCYETAgmBBMCJgQTAiaEnxboihYsGmarVAAAAABJRU5ErkJggg==';

const REMOTE_IMAGE_HOSTS = ['picsum.photos'];

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

import { expect, type Locator } from '@playwright/test';

export async function waitForImageDecoded(image: Locator): Promise<void> {
  await expect
    .poll(() =>
      image
        .evaluate(
          (element) =>
            element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
        )
        .catch(() => false),
    )
    .toBe(true);
}

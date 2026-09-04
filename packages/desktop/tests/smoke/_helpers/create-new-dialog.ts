import type { Page } from '@playwright/test';
import { expect } from './smoke-test';

export async function typeProjectName(page: Page, name: string): Promise<void> {
  const nameInput = page.locator('[data-testid="create-name"]');
  await expect(nameInput).toBeVisible({ timeout: 5_000 });
  await nameInput.fill(name);
}

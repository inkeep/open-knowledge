import type { Page } from '@playwright/test';
import { expect } from './smoke-test';

/**
 * Fill the Create-new-project dialog's name field. The name input is the first
 * control inside an already-visible dialog, so it is present synchronously — no
 * Apple-Event/IPC roundtrip to wait out.
 */
export async function typeProjectName(page: Page, name: string): Promise<void> {
  const nameInput = page.locator('[data-testid="create-name"]');
  await expect(nameInput).toBeVisible({ timeout: 5_000 });
  await nameInput.fill(name);
}

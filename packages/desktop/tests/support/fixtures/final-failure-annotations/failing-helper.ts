import { expect } from '@playwright/test';

export function expectTheImpossible(): void {
  expect(1, 'the helper asserts something false').toBe(2);
}

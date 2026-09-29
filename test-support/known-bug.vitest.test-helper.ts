import { expect } from 'vitest';
import { expectKnownBug as catchKnownBug } from './known-bug.test-helper';

export async function expectKnownBug(
  signature: RegExp,
  assertCorrectBehaviour: () => unknown,
): Promise<string> {
  const message = await catchKnownBug(signature, assertCorrectBehaviour);
  expect(message).toMatch(signature);
  return message;
}

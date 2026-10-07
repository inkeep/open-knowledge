import { expect, test } from 'vitest';
import { describeBoth } from './mock-consumer';

test('an unrelated file imports the real module', () => {
  expect(describeBoth()).toBe('real-alpha+real-beta');
});

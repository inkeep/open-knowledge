import { expect, test, vi } from 'vitest';
import { describeBoth } from './mock-consumer';

vi.mock('./mock-subject', async () => {
  throw new Error('planted factory rejection');
});

test('a file whose mocked import rejects never reaches its tests', () => {
  expect(describeBoth()).toBe('unreachable');
});

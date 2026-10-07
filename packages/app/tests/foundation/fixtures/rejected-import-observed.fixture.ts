import { expect, test, vi } from 'vitest';

vi.mock('./mock-subject', async () => {
  throw new Error('planted factory rejection');
});

test('a test that expects its mocked import to reject observes the rejection', async () => {
  await expect(import('./mock-consumer')).rejects.toThrow(
    'vi.mock factory for /tests/foundation/fixtures/mock-subject.ts rejected',
  );
});

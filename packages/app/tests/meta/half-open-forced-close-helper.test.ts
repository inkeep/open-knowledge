import { describe, expect, test } from 'vitest';
import { waitForTransport } from '../half-open-forced-close.test-helper';

describe('waitForTransport', () => {
  test('a fault inside the predicate reaches the caller unchanged', async () => {
    const fault = new TypeError("Cannot read properties of undefined (reading 'documents')");

    await expect(
      waitForTransport(
        'the server to receive a marker',
        () => {
          throw fault;
        },
        5_000,
      ),
    ).rejects.toBe(fault);
  });

  test('a genuine stall names the stage that hung', async () => {
    await expect(waitForTransport('the socket to reconnect', () => false, 60)).rejects.toThrow(
      /the socket to reconnect/,
    );
  });
});

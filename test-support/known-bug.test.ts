import { describe, expect, test } from 'vitest';
import { expectKnownBug } from './known-bug.test-helper';
import { expectKnownBug as expectKnownBugInVitest } from './known-bug.vitest.test-helper';

const ESC = String.fromCharCode(27);

describe('expectKnownBug', () => {
  test('passes and returns the message when the correct assertion fails with the signature', async () => {
    const message = await expectKnownBug(/row still visible/, () => {
      throw new Error('sidebar row still visible after hide');
    });
    expect(message).toBe('sidebar row still visible after hide');
  });

  test('accepts an asynchronous assertion that rejects with the signature', async () => {
    await expect(
      expectKnownBug(/ordinal 1/, async () => {
        await Promise.resolve();
        throw new Error('expected ordinal 2, received ordinal 1');
      }),
    ).resolves.toBe('expected ordinal 2, received ordinal 1');
  });

  test('fails with "appears fixed" when the correct assertion passes', async () => {
    await expect(expectKnownBug(/row still visible/, () => undefined)).rejects.toThrow(
      /^known bug appears fixed: .*\/row still visible\/.*Remove the pin/,
    );
  });

  test('rethrows an unrelated failure unchanged', async () => {
    const unrelated = new TypeError('cannot read properties of undefined');
    await expect(
      expectKnownBug(/row still visible/, () => {
        throw unrelated;
      }),
    ).rejects.toBe(unrelated);
  });

  test('matches against the message with ANSI colour codes removed', async () => {
    const coloured = `Expected: ${ESC}[32m"hidden"${ESC}[39m\nReceived: ${ESC}[31m"visible"${ESC}[39m`;
    await expect(
      expectKnownBug(/Received: "visible"/, () => {
        throw new Error(coloured);
      }),
    ).resolves.toBe('Expected: "hidden"\nReceived: "visible"');
  });

  test('does not match a signature that only appears inside the colour codes', async () => {
    const coloured = `Received: ${ESC}[31m"visible"${ESC}[39m`;
    const failure = new Error(coloured);
    await expect(
      expectKnownBug(/\[31m/, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  test('matches a thrown non-Error value by its string form', async () => {
    await expect(
      expectKnownBug(/ENOENT/, () => {
        throw 'ENOENT: no such file';
      }),
    ).resolves.toBe('ENOENT: no such file');
  });

  test('ignores a global signature’s lastIndex', async () => {
    const signature = /visible/g;
    signature.lastIndex = 99;
    await expect(
      expectKnownBug(signature, () => {
        throw new Error('row visible');
      }),
    ).resolves.toBe('row visible');
  });
});

describe('expectKnownBug for Vitest', () => {
  test('counts as one assertion even when the correct assertion never reaches expect', async () => {
    const before = expect.getState().assertionCalls;
    await expectKnownBugInVitest(/ENOENT/, () => {
      throw new Error('ENOENT: no such file');
    });
    const made = expect.getState().assertionCalls - before;
    expect(made).toBe(1);
  });

  test('passes on a failing Vitest assertion that names the wrong value', async () => {
    await expectKnownBugInVitest(/expected 1 to be 2/, () => {
      expect(1).toBe(2);
    });
  });

  test('fails with "appears fixed" when the bug is gone', async () => {
    await expect(expectKnownBugInVitest(/expected 1 to be 2/, () => undefined)).rejects.toThrow(
      /^known bug appears fixed/,
    );
  });

  test('rethrows an unrelated failure unchanged', async () => {
    const unrelated = new RangeError('out of range');
    await expect(
      expectKnownBugInVitest(/expected 1 to be 2/, () => {
        throw unrelated;
      }),
    ).rejects.toBe(unrelated);
  });
});

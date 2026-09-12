import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { withFsCopyCompletionObserver } from './fs-copy-observer.test-helper.ts';
import { tracedCpSync } from './fs-traced.ts';

let root: string;
let source: string;
let witness: string;

const at = (...segments: string[]): string => join(root, ...segments);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-fs-copy-observer-'));
  source = join(root, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'file.txt'), 'source bytes');
  witness = join(root, 'witness.txt');
  writeFileSync(witness, 'untouched');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('fs copy completion observer', () => {
  test('an unrelated copy landing first does not consume the one-shot latch', async () => {
    const fired: string[] = [];
    let unrelatedExistedAtFire: boolean | undefined;
    let laterMatchExistedAtFire: boolean | undefined;

    await withFsCopyCompletionObserver(
      (destination) => destination.endsWith(join('copies', 'wanted')),
      (destination) => {
        fired.push(destination);
        unrelatedExistedAtFire = existsSync(at('host-a', 'copies', 'unrelated'));
        laterMatchExistedAtFire = existsSync(at('host-b', 'copies', 'wanted'));
        writeFileSync(witness, `fired at ${destination}`);
      },
      async () => {
        tracedCpSync(source, at('host-a', 'copies', 'unrelated'), { recursive: true });
        tracedCpSync(source, at('host-a', 'copies', 'wanted'), { recursive: true });
        tracedCpSync(source, at('host-b', 'copies', 'wanted'), { recursive: true });
      },
    );

    expect(fired).toHaveLength(1);
    expect(fired[0]).toContain(join('copies', 'wanted'));
    expect(unrelatedExistedAtFire).toBe(true);
    expect(laterMatchExistedAtFire).toBe(false);
    expect(readFileSync(witness, 'utf8')).toBe(`fired at ${fired[0]}`);
    for (const copied of [
      ['host-a', 'copies', 'unrelated'],
      ['host-a', 'copies', 'wanted'],
      ['host-b', 'copies', 'wanted'],
    ]) {
      expect(readFileSync(join(at(...copied), 'file.txt'), 'utf8')).toBe('source bytes');
    }
  });

  test('a run the matcher never accepted fails loudly and names the destinations it saw', async () => {
    await expect(
      withFsCopyCompletionObserver(
        (destination) => destination.endsWith(join('copies', 'never-copied')),
        () => {
          writeFileSync(witness, 'callback ran');
        },
        async () => {
          tracedCpSync(source, at('host-a', 'copies', 'unrelated'), { recursive: true });
        },
      ),
    ).rejects.toThrow(join('copies', 'unrelated'));

    expect(readFileSync(witness, 'utf8')).toBe('untouched');
  });

  test('a throwing callback surfaces its own error rather than the no-match diagnostic', async () => {
    await expect(
      withFsCopyCompletionObserver(
        (destination) => destination.endsWith(join('copies', 'wanted')),
        () => {
          throw new Error('callback exploded');
        },
        async () => {
          tracedCpSync(source, at('host-a', 'copies', 'wanted'), { recursive: true });
        },
      ),
    ).rejects.toThrow('callback exploded');
  });
});

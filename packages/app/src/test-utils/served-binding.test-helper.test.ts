import { describe, expect, test } from 'vitest';
import { createServedBindingLog } from './served-binding.test-helper';

const SPECIFIER = 'fixture-module';
const THIS_FILE = 'test-utils/served-binding.test-helper.test.ts';

describe('served-binding log', () => {
  test('a served member reads through to the live value of the original export', () => {
    let flag = false;
    const log = createServedBindingLog();
    const served = log.serve(SPECIFIER, {
      get FLAG() {
        return flag;
      },
    });

    expect(served.FLAG).toBe(false);
    flag = true;
    expect(served.FLAG).toBe(true);
  });

  test('a read is attributed to the source file that performed it, not to the log', () => {
    const log = createServedBindingLog();
    const served = log.serve(SPECIFIER, { value: 1 });

    expect([served].map((exports) => exports.value)).toEqual([1]);
    expect(log.readersOf(SPECIFIER, 'value')).toEqual([THIS_FILE]);
  });

  test('readers are counted per member and only after the given mark', () => {
    const log = createServedBindingLog();
    const served = log.serve(SPECIFIER, { early: 1, late: 2, unread: 3 });

    expect(served.early).toBe(1);
    const since = log.mark();
    expect(served.late).toBe(2);

    expect(log.readersOf(SPECIFIER, 'early')).toEqual([THIS_FILE]);
    expect(log.readersOf(SPECIFIER, 'early', since)).toEqual([]);
    expect(log.readersOf(SPECIFIER, 'late', since)).toEqual([THIS_FILE]);
    expect(log.readersOf(SPECIFIER, 'unread')).toEqual([]);
    expect(log.readersOf('another-module', 'late')).toEqual([]);
  });

  test('serving a module reads none of its members', () => {
    const log = createServedBindingLog();
    const served = log.serve(SPECIFIER, { value: 1 });

    expect(Object.keys(served)).toEqual(['value']);
    expect(log.readersOf(SPECIFIER, 'value')).toEqual([]);
  });
});

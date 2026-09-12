import { describe, expect, test } from 'vitest';
import { configFileDeclineDetail, configFileDeclineReason } from './config-file-error.ts';

describe('configFileDeclineReason', () => {
  test.each([
    ['EACCES', 'permission-denied'],
    ['EPERM', 'permission-denied'],
    ['ELOOP', 'unresolved-symlink'],
    ['EISDIR', 'not-a-file'],
    ['ENOTDIR', 'not-a-file'],
    ['EIO', 'unreadable'],
    ['ENOENT', 'disappeared'],
  ])('preserves the actionable category for %s', (code, reason) => {
    expect(configFileDeclineReason(Object.assign(new Error(code), { code }))).toBe(reason);
  });

  test.each([null, undefined, new Error('read failed')])(
    'reports an unknown read failure without inventing a syntax problem',
    (error) => {
      expect(configFileDeclineReason(error)).toBe('unreadable');
    },
  );

  test('an I/O failure suggests restoring access without inventing a permissions diagnosis', () => {
    const error = Object.assign(new Error('device unavailable'), { code: 'EIO' });
    const detail = configFileDeclineDetail(configFileDeclineReason(error));
    expect(detail).toContain('could not be read');
    expect(detail).toContain('check that the path is accessible');
    expect(detail).not.toContain('permission denied');
  });
});

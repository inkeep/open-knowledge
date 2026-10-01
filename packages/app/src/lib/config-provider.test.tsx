import { describe, expect, test } from 'vitest';
import { ConfigProvider, useConfigContext } from './config-provider';

describe('ConfigProvider module surface', () => {
  test('exports ConfigProvider component and useConfigContext hook', () => {
    expect(typeof ConfigProvider).toBe('function');
    expect(typeof useConfigContext).toBe('function');
  });
});

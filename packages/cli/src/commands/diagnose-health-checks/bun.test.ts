import { describe, expect, test } from 'bun:test';
import { makeBunCheck } from './bun.ts';

const ctx = { cwd: '/tmp/bun-check-test' };

describe('bun check', () => {
  test('passes with the detected version when probe succeeds', async () => {
    const def = makeBunCheck({ probe: () => ({ ok: true, version: '1.3.13' }) });
    const result = await def.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.summary).toContain('1.3.13');
  });

  test('fails with install-Bun guidance when probe reports missing', async () => {
    const def = makeBunCheck({
      probe: () => ({ ok: false, error: 'spawn bun ENOENT' }),
    });
    const result = await def.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('bun not found');
    expect(result.remediation).toContain('https://bun.sh');
    expect(result.detail).toContain('ENOENT');
  });
});

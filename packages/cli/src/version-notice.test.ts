import { describe, expect, test } from 'vitest';
import { buildVersionNotice } from './version-notice.ts';

describe('buildVersionNotice', () => {
  test('leads with the version, then the copyright / free-software / no-warranty trio', () => {
    const notice = buildVersionNotice('1.2.3');
    expect(notice.split('\n')[0]).toBe('1.2.3');
    expect(notice).toMatch(/Copyright \(C\) \d{4} Inkeep, Inc\./);
    expect(notice).toContain('GPL-3.0-or-later');
    expect(notice).toMatch(/free software/i);
    expect(notice).toMatch(/NO WARRANTY/);
  });
});

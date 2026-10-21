import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localIsoDate } from './local-iso-date.ts';

describe('localIsoDate', () => {
  let originalTz: string | undefined;

  beforeEach(() => {
    originalTz = process.env.TZ;
  });

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('keeps the local date when UTC has already rolled over to the next day', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(localIsoDate(new Date('2026-10-19T00:15:00Z'))).toBe('2026-10-18');
  });

  it('advances to the local date when the local zone is ahead of UTC', () => {
    process.env.TZ = 'Pacific/Kiritimati';
    expect(localIsoDate(new Date('2026-10-18T12:00:00Z'))).toBe('2026-10-19');
  });

  it('zero-pads month and day', () => {
    expect(localIsoDate(new Date(2026, 0, 9, 12))).toBe('2026-01-09');
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readWellKnownIndex } from './well-known.ts';

const fixture = vi.hoisted(() => ({
  home: '',
  addresses: [] as { address: string; family: number }[],
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => fixture.home,
}));
vi.mock('node:dns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns')>()),
  lookup: (_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    queueMicrotask(() => {
      if (options.all) callback(null, fixture.addresses);
      else callback(null, fixture.addresses[0]?.address, fixture.addresses[0]?.family);
    });
  },
}));

describe('website skill resolved-address admission', () => {
  beforeEach(() => {
    fixture.home = mkdtempSync(join(tmpdir(), 'skill-dns-policy-'));
  });
  afterEach(() => {
    rmSync(fixture.home, { recursive: true, force: true });
  });

  test.each([
    [],
    ['127.0.0.1'],
    ['93.184.216.34', '127.0.0.1'],
    ['93.184.216.34', '::1'],
    ['2606:4700:4700::1111', '10.0.0.1'],
    ['::ffff:127.0.0.1'],
    ['::ffff:93.184.216.34'],
    ['169.254.169.254'],
  ])('rejects an empty or mixed nonpublic DNS answer %j', async (...addresses: string[]) => {
    fixture.addresses = addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
    await expect(readWellKnownIndex('https://localhost', { timeoutMs: 1000 })).rejects.toThrow(
      /require public addresses/,
    );
  });
});

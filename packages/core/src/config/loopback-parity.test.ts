import { describe, expect, test } from 'vitest';
import { isLoopbackHostname } from '../../../../test-support/no-net-connect.ts';
import { isLoopbackBindAddress } from './resolve-server-config.ts';

const NAMED = ['localhost', '::1', '[::1]', '0.0.0.0', '::', 'example.com', 'notlocalhost'];
const OCTETS = [0, 1, 9, 10, 99, 100, 127, 128, 199, 200, 249, 250, 255, 256, 300, 999];

function octetCorpus(): string[] {
  const hosts: string[] = [];
  for (let position = 0; position < 4; position += 1) {
    for (const octet of OCTETS) {
      const parts = ['127', '0', '0', '1'];
      parts[position] = String(octet);
      hosts.push(parts.join('.'));
    }
  }
  return hosts;
}

describe('loopback predicate parity with the hermetic-test guard', () => {
  test('agrees with the core bind-address predicate across the octet corpus', () => {
    for (const host of [...NAMED, ...octetCorpus()]) {
      expect(isLoopbackHostname(host), host).toBe(isLoopbackBindAddress(host));
    }
  });

  test('these divergences from core are deliberate', () => {
    expect(isLoopbackHostname('app.localhost')).toBe(true);
    expect(isLoopbackBindAddress('app.localhost')).toBe(false);

    expect(isLoopbackHostname(' localhost ')).toBe(false);
    expect(isLoopbackBindAddress(' localhost ')).toBe(true);

    expect(isLoopbackHostname('[127.0.0.1]')).toBe(true);
    expect(isLoopbackBindAddress('[127.0.0.1]')).toBe(false);
  });
});

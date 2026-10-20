import type { BigIntStats } from 'node:fs';

export function filesystemIdentity(stats: Pick<BigIntStats, 'dev' | 'ino'>): `${bigint}:${bigint}` {
  return `${stats.dev}:${stats.ino}`;
}

export function statMtimeMs(stats: Pick<BigIntStats, 'mtimeNs'>): number {
  const nanoseconds = ((stats.mtimeNs % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n;
  const seconds = (stats.mtimeNs - nanoseconds) / 1_000_000_000n;
  return Number(seconds) * 1_000 + Number(nanoseconds) / 1_000_000;
}

export function statMtime(stats: Pick<BigIntStats, 'mtimeNs'>): Date {
  return new Date(Math.round(statMtimeMs(stats)));
}

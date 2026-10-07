import type { BigIntStats } from 'node:fs';

const TIMESTAMP_GRANULARITY_BOUND_NS = 3_000_000_000n;

const NS_PER_MS = 1_000_000n;

export const sampleWallClockNs = (): bigint => BigInt(Date.now()) * NS_PER_MS;

export const statSignature = (stats: BigIntStats): string =>
  `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;

export const isRacyStat = (stats: BigIntStats, sampledAtNs: bigint): boolean =>
  stats.ctimeNs + TIMESTAMP_GRANULARITY_BOUND_NS > sampledAtNs ||
  (stats.mtimeNs + TIMESTAMP_GRANULARITY_BOUND_NS > sampledAtNs &&
    stats.mtimeNs <= sampledAtNs + TIMESTAMP_GRANULARITY_BOUND_NS);

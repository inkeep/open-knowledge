import { randomUUID } from 'node:crypto';

export const ATOMIC_TEMP_INFIX = '.tmp.';

const UUID_HEX_GROUP_LENGTHS = [8, 4, 4, 4, 12] as const;

function escapeRegExpLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const UUID_HEX_GLOB = UUID_HEX_GROUP_LENGTHS.map((length) => '[0-9a-f]'.repeat(length)).join('-');

const UUID_HEX_PATTERN = UUID_HEX_GROUP_LENGTHS.map((length) => `[0-9a-f]{${length}}`).join('-');

export const ATOMIC_TEMP_GLOB = `*${ATOMIC_TEMP_INFIX}${UUID_HEX_GLOB}`;

export const ATOMIC_TEMP_PATH_RE = new RegExp(
  `${escapeRegExpLiteral(ATOMIC_TEMP_INFIX)}${UUID_HEX_PATTERN}$`,
);

export function atomicTempPath(absPath: string): string {
  return `${absPath}${ATOMIC_TEMP_INFIX}${randomUUID()}`;
}

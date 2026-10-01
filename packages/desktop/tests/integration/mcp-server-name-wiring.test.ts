import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const indexTsPath = resolve(fileURLToPath(new URL('../../src/main/index.ts', import.meta.url)));
const src = readFileSync(indexTsPath, 'utf-8');

const FIX = (what: string): string =>
  `\n[mcp-server-name] ${what}\n\n` +
  `Every renderer window learns its channel's MCP server key only from the argv main appends in\n` +
  `withWindowRuntimeArgs. Without that append the preload exposes mcpServerName as null and the\n` +
  `settings copy stops naming the key this channel writes, with no error anywhere. index.ts cannot\n` +
  `be imported under vitest, so the helper's own tests stay green while this call site rots.\n`;

describe('renderer-window MCP server-name wiring (bypass-pin)', () => {
  test('withWindowRuntimeArgs appends the channel server key to the args it was given', () => {
    const fn =
      /function withWindowRuntimeArgs\(args: readonly string\[\]\): string\[\] \{([\s\S]*?)\n\}/.exec(
        src,
      );
    expect(fn, FIX('withWindowRuntimeArgs is no longer recognisable in index.ts.')).not.toBeNull();
    expect(
      /withMcpServerNameArg\(args\)/.test(fn?.[1] ?? ''),
      FIX('withWindowRuntimeArgs no longer passes its args through withMcpServerNameArg.'),
    ).toBe(true);
  });
});

import { describe, expect, test } from 'vitest';
import { buildOkMcpStdioCommand } from './thread-manager.ts';

/**
 * The stdio `ok mcp` command is the fallback that carries OK MCP tools to
 * agents whose ACP adapter doesn't advertise HTTP-MCP support (e.g. Claude
 * Code's). It must pin to a specific server port (`--port`) so the shim proxies
 * to THIS server rather than auto-discovering some other install.
 */
describe('buildOkMcpStdioCommand', () => {
  test('uses the host CLI entrypoint when provided (packaged app / ok start)', () => {
    expect(buildOkMcpStdioCommand(['/usr/bin/ok-bin', '/app/cli.js'], 5174)).toEqual({
      command: '/usr/bin/ok-bin',
      args: ['/app/cli.js', 'mcp', '--port', '5174'],
    });
  });

  test('falls back to `open-knowledge` on PATH when no entrypoint is resolvable (dev server)', () => {
    expect(buildOkMcpStdioCommand(undefined, 3000)).toEqual({
      command: 'open-knowledge',
      args: ['mcp', '--port', '3000'],
    });
    expect(buildOkMcpStdioCommand([], 3000)).toEqual({
      command: 'open-knowledge',
      args: ['mcp', '--port', '3000'],
    });
  });

  test('always pins to the given port', () => {
    expect(buildOkMcpStdioCommand(['ok'], 61999).args).toContain('--port');
    expect(buildOkMcpStdioCommand(['ok'], 61999).args.at(-1)).toBe('61999');
  });
});

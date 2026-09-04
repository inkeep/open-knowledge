import { describe, expect, test, vi } from 'vitest';
import type { PinoLogger } from '../logger.ts';
import { buildOkMcpStdioCommand } from './thread-manager.ts';

const unresolvable = { resolveCommand: () => null };

describe('buildOkMcpStdioCommand', () => {
  test('uses the host CLI entrypoint when provided (packaged app / ok start)', () => {
    const resolveCommand = vi.fn(() => '/never/used');
    expect(
      buildOkMcpStdioCommand(['/usr/bin/ok-bin', '/app/cli.js'], 5174, { resolveCommand }),
    ).toEqual({
      command: '/usr/bin/ok-bin',
      args: ['/app/cli.js', 'mcp', '--port', '5174'],
    });
    expect(resolveCommand).not.toHaveBeenCalled();
  });

  test('resolves the bare `open-knowledge` fallback to an absolute path (dev server)', () => {
    const resolveCommand = vi.fn(() => '/opt/homebrew/bin/open-knowledge');
    expect(buildOkMcpStdioCommand(undefined, 3000, { resolveCommand })).toEqual({
      command: '/opt/homebrew/bin/open-knowledge',
      args: ['mcp', '--port', '3000'],
    });
    expect(resolveCommand).toHaveBeenCalledWith('open-knowledge');
    expect(buildOkMcpStdioCommand([], 3000, { resolveCommand }).command).toBe(
      '/opt/homebrew/bin/open-knowledge',
    );
  });

  test('also resolves a bare name the host supplied itself', () => {
    expect(
      buildOkMcpStdioCommand(['ok'], 3000, { resolveCommand: () => '/usr/local/bin/ok' }),
    ).toEqual({
      command: '/usr/local/bin/ok',
      args: ['mcp', '--port', '3000'],
    });
  });

  test('keeps the bare name and warns when PATH has no answer', () => {
    const warn = vi.fn();
    const log = { warn } as unknown as PinoLogger;
    expect(buildOkMcpStdioCommand(undefined, 3000, { resolveCommand: () => null, log })).toEqual({
      command: 'open-knowledge',
      args: ['mcp', '--port', '3000'],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ command: 'open-knowledge' });
  });

  test('an unresolvable name without a logger still degrades to the bare command', () => {
    expect(buildOkMcpStdioCommand(undefined, 3000, unresolvable)).toEqual({
      command: 'open-knowledge',
      args: ['mcp', '--port', '3000'],
    });
  });

  test('always pins to the given port', () => {
    expect(buildOkMcpStdioCommand(['ok'], 61999, unresolvable).args).toContain('--port');
    expect(buildOkMcpStdioCommand(['ok'], 61999, unresolvable).args.at(-1)).toBe('61999');
  });
});

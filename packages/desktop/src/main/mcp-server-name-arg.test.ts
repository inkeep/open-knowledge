import { afterEach, describe, expect, test, vi } from 'vitest';
import { withMcpServerNameArg } from './mcp-server-name-arg.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderer-window MCP server-name argv', () => {
  test('a Beta run hands the window its own server key', () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    expect(withMcpServerNameArg(['--ok-mode=editor'])).toEqual([
      '--ok-mode=editor',
      '--ok-mcp-server-name=open-knowledge-beta',
    ]);
  });

  test('a Stable run hands the window the Stable server key', () => {
    vi.stubEnv('OK_CHANNEL', 'stable');
    expect(withMcpServerNameArg(['--ok-mode=editor'])).toEqual([
      '--ok-mode=editor',
      '--ok-mcp-server-name=open-knowledge',
    ]);
  });
});

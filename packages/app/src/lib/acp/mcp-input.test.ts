import { describe, expect, test } from 'vitest';
import { unwrapMcpInput } from './mcp-input';

describe('unwrapMcpInput', () => {
  test('non-JSON arguments string falls back to the outer input', () => {
    const input = { tool: 'write', arguments: 'not valid json' };
    expect(unwrapMcpInput(input)).toEqual({ tool: 'write', args: input });
  });

  test('JSON-string arguments that parse to a non-object fall back to the outer input', () => {
    const input = { tool: 'write', arguments: '"just a string"' };
    expect(unwrapMcpInput(input)).toEqual({ tool: 'write', args: input });
  });

  test('non-object rawInput is rejected', () => {
    expect(unwrapMcpInput('write')).toBeNull();
    expect(unwrapMcpInput(null)).toBeNull();
    expect(unwrapMcpInput(7)).toBeNull();
  });
});

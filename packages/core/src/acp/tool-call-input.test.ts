import { describe, expect, test } from 'vitest';
import {
  identifyOpenKnowledgeToolCall,
  openKnowledgeToolName,
  shellCommandFromRawInput,
  unwrapMcpInput,
} from './tool-call-input.ts';

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

describe('identifyOpenKnowledgeToolCall', () => {
  test('reads the tool out of the title shapes each harness writes', () => {
    expect(
      identifyOpenKnowledgeToolCall({ title: 'mcp__open-knowledge__search', rawInput: {} }),
    ).toEqual({ tool: 'search', args: {} });
    expect(
      identifyOpenKnowledgeToolCall({
        title: 'mcp.open-knowledge.edit',
        rawInput: { server: 'open-knowledge', tool: 'edit', arguments: { document: 'a' } },
      }),
    ).toEqual({ tool: 'edit', args: { document: 'a' } });
    expect(identifyOpenKnowledgeToolCall({ title: 'ok_exec', rawInput: {} })).toEqual({
      tool: 'exec',
      args: {},
    });
  });

  test('a call to another server or another tool is not an OK call', () => {
    expect(
      identifyOpenKnowledgeToolCall({ title: 'mcp__github__search', rawInput: {} }),
    ).toBeNull();
    expect(
      identifyOpenKnowledgeToolCall({
        title: 'mcp.open-knowledge.edit',
        rawInput: { server: 'github', tool: 'edit' },
      }),
    ).toBeNull();
    expect(
      identifyOpenKnowledgeToolCall({ title: 'Bash', rawInput: { command: 'ls' } }),
    ).toBeNull();
    expect(identifyOpenKnowledgeToolCall({ title: null, rawInput: undefined })).toBeNull();
  });

  test('display matching admits any OK-looking server alias', () => {
    expect(openKnowledgeToolName({ title: 'mcp__ok-payments__write', rawInput: {} })).toBe('write');
    expect(openKnowledgeToolName({ title: 'write', rawInput: { tool: 'write' } })).toBe('write');
  });

  test('known-server matching needs the server we inject, its dev alias, or the Pi bridge prefix', () => {
    for (const title of [
      'mcp__open-knowledge__write',
      'mcp__open-knowledge-dev__write',
      'mcp.open_knowledge.write',
      'ok_write',
    ]) {
      expect(identifyOpenKnowledgeToolCall({ title, rawInput: {} }, 'known')?.tool).toBe('write');
    }
    for (const title of ['mcp__ok__write', 'mcp__ok-dev__write', 'mcp.ok.write', 'ok-dev_write']) {
      expect(identifyOpenKnowledgeToolCall({ title, rawInput: {} }, 'known')).toBeNull();
    }
    expect(
      identifyOpenKnowledgeToolCall({ title: 'ok_write', rawInput: { server: 'ok' } }, 'known'),
    ).toBeNull();
    expect(
      identifyOpenKnowledgeToolCall(
        {
          title: 'mcp.open-knowledge.edit',
          rawInput: { server: 'open-knowledge', tool: 'edit', arguments: { document: 'a' } },
        },
        'known',
      ),
    ).toEqual({ tool: 'edit', args: { document: 'a' } });
    for (const call of [
      { title: 'mcp__ok-payments__write', rawInput: {} },
      { title: 'mcp__open-knowledge-shadow__write', rawInput: {} },
      { title: 'write', rawInput: { tool: 'write' } },
      { title: 'write', rawInput: { server: 'ok-payments', tool: 'write' } },
      { title: 'mcp__open-knowledge__write', rawInput: { server: 'github' } },
    ]) {
      expect(identifyOpenKnowledgeToolCall(call, 'known')).toBeNull();
    }
  });

  test('known-server matching never trusts rawInput on its own: the title has to name the tool', () => {
    for (const call of [
      { title: 'write', rawInput: { server: 'open-knowledge', tool: 'write' } },
      { title: 'Bash', rawInput: { server: 'open-knowledge', tool: 'write', command: 'rm -rf x' } },
      { title: 'mcp__github__write', rawInput: { server: 'open-knowledge', tool: 'write' } },
      { title: 'mcp__open-knowledge__search', rawInput: { tool: 'delete' } },
      { title: 'mcp__open-knowledge__search', rawInput: { name: 'write' } },
    ]) {
      expect(identifyOpenKnowledgeToolCall(call, 'known')).toBeNull();
    }
  });

  test('a known server does not vouch for a tool name outside the OK tool list', () => {
    for (const call of [
      { title: 'mcp__open-knowledge__format_disk', rawInput: {} },
      { title: 'ok_shell', rawInput: {} },
      { title: 'format_disk', rawInput: { server: 'open-knowledge', tool: 'format_disk' } },
      { title: 'mcp.open-knowledge.run', rawInput: { server: 'open-knowledge', tool: 'run' } },
    ]) {
      expect(identifyOpenKnowledgeToolCall(call, 'known')).toBeNull();
      expect(identifyOpenKnowledgeToolCall(call)).toBeNull();
    }
  });
});

describe('shellCommandFromRawInput', () => {
  test('reads the command a bash tool call carries', () => {
    expect(shellCommandFromRawInput({ command: 'ls -la', description: 'list' })).toBe('ls -la');
  });

  test('reads the script out of the shell wrapper a Codex exec approval carries', () => {
    const approval = {
      call_id: 'call_1',
      command: ['bash', '-lc', 'ls; pwd'],
      cwd: '/repo',
      parsed_cmd: [],
    };
    expect(shellCommandFromRawInput(approval)).toBe('ls; pwd');
    expect(shellCommandFromRawInput({ command: ['/bin/zsh', '-lc', 'echo hi'] })).toBe('echo hi');
    expect(shellCommandFromRawInput({ command: ['sh', '-c', 'make test'] })).toBe('make test');
  });

  test('an interpreter outside the system bin dirs is never elided from the gate', () => {
    for (const shell of ['./sh', '/tmp/agent-work/bash', 'C:\\Users\\x\\evil\\bash.exe']) {
      expect(shellCommandFromRawInput({ command: [shell, '-lc', 'ls'] })).toContain(shell);
    }
    expect(shellCommandFromRawInput({ command: ['/usr/local/bin/bash', '-lc', 'ls'] })).toBe('ls');
  });

  test('joins any other argv into the line a shell would read the same way', () => {
    expect(
      shellCommandFromRawInput({ command: ['git', 'commit', '-m', "fix the user's bug"] }),
    ).toBe("git commit -m 'fix the user'\\''s bug'");
    expect(shellCommandFromRawInput({ command: ['bash', '-x', 'script.sh'] })).toBe(
      'bash -x script.sh',
    );
    expect(shellCommandFromRawInput({ command: ['echo', ''] })).toBe("echo ''");
  });

  test('declines anything that is not a usable command', () => {
    for (const input of [
      null,
      undefined,
      {},
      [],
      'ls',
      { command: '' },
      { command: '   ' },
      { command: 42 },
      { command: [] },
      { command: ['ls', 1] },
      { command: ['bash', '-lc', '  '] },
    ]) {
      expect({ input, got: shellCommandFromRawInput(input) }).toEqual({ input, got: null });
    }
  });
});

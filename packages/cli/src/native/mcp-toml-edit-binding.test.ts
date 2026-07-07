import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the insert-only upsert/remove + symlink-resolution across the real
// JS<->Rust boundary by loading the built `.node` directly. The Rust unit tests
// cover the engine's document + path semantics exhaustively; this guards the
// napi marshalling the Rust tests cannot reach — the `McpEditResult` /
// `SymlinkWritePaths` struct return shapes (including `Option<String>` ->
// `undefined`), string in/out, and the throw on malformed input. It
// hard-requires the addon (rather than skipping when absent) so a gate that
// failed to build the binding fails loudly instead of vacuously passing,
// matching `toml-config-engine.test.ts`.

interface McpEditResult {
  text: string;
  changed: boolean;
  existed: boolean;
}

interface SymlinkWritePaths {
  readPath?: string;
  writePath: string;
}

interface NativeMcpEditBinding {
  upsertMcpServer(tomlText: string, serverName: string, entryJson: string): McpEditResult;
  removeMcpServer(tomlText: string, serverName: string): McpEditResult;
  resolveSymlinkWritePath(path: string): SymlinkWritePaths;
}

const require = createRequire(import.meta.url);
const binding = require('@inkeep/open-knowledge-native-config') as NativeMcpEditBinding;

const SERVER = 'open-knowledge';
const ENTRY = JSON.stringify({ command: '/bin/sh', args: ['-l', '-c', 'run-ok'] });

describe('native mcp toml-edit binding', () => {
  test('upserts a fresh entry, preserving a sibling and its comment', () => {
    const input = '[mcp_servers.other]\ncommand = "other"  # keep\n';
    const result = binding.upsertMcpServer(input, SERVER, ENTRY);
    expect(result.changed).toBe(true);
    expect(result.existed).toBe(false);
    expect(typeof result.text).toBe('string');
    expect(result.text).toContain('[mcp_servers.open-knowledge]');
    expect(result.text).toContain('command = "other"  # keep');
  });

  test('reports existed=true when updating an entry that is already present', () => {
    const input = '[mcp_servers.open-knowledge]\ncommand = "/old"\n';
    const result = binding.upsertMcpServer(input, SERVER, ENTRY);
    expect(result.existed).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.text).toContain('/bin/sh');
  });

  test('a re-upsert of the canonical entry is a byte-identical no-op', () => {
    const first = binding.upsertMcpServer('[other]\nx = 1\n', SERVER, ENTRY).text;
    const second = binding.upsertMcpServer(first, SERVER, ENTRY);
    expect(second.changed).toBe(false);
    expect(second.text).toBe(first);
  });

  test('remove deletes only our entry and reports the change', () => {
    const input = `[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.open-knowledge]\ncommand = "/bin/sh"\n`;
    const result = binding.removeMcpServer(input, SERVER);
    expect(result.changed).toBe(true);
    expect(result.text).not.toContain('[mcp_servers.open-knowledge]');
    expect(result.text).toContain('[mcp_servers.other]');
  });

  test('the binding throws across the boundary on malformed TOML', () => {
    expect(() => binding.upsertMcpServer('a = = b', SERVER, ENTRY)).toThrow();
  });

  test('resolveSymlinkWritePath marshals a real target back as both paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-resolve-'));
    try {
      const plain = join(dir, 'config.toml');
      writeFileSync(plain, 'x = 1\n');
      const resolved = binding.resolveSymlinkWritePath(plain);
      expect(resolved.writePath).toBe(plain);
      expect(resolved.readPath).toBe(plain);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolveSymlinkWritePath marshals a cyclic chain as an undefined readPath', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-resolve-'));
    try {
      // config -> a -> b -> a: the resolver breaks the cycle by declining a
      // read target and writing through the original path. The absent
      // `read_path` must cross the boundary as `undefined`, not an empty string.
      symlinkSync('b.toml', join(dir, 'a.toml'));
      symlinkSync('a.toml', join(dir, 'b.toml'));
      const config = join(dir, 'config.toml');
      symlinkSync('a.toml', config);
      const resolved = binding.resolveSymlinkWritePath(config);
      expect(resolved.readPath).toBeUndefined();
      expect(resolved.writePath).toBe(config);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

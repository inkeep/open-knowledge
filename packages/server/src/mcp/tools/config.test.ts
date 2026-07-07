import { describe as _bunDescribe, expect, test } from 'bun:test';

// Skip-on-CI gate (oven-sh/bun#11892): simple-git fixture pattern in MCP
// test setup spawns git children that Bun fails to reap on ubuntu-latest
// GHA runners; post-test cgroup never drains, hanging test (test) at the
// 15-min timeout. Tests run normally locally; follow-up PR will migrate
// fixtures to execFileSync.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { register } from './config.ts';
import type { ServerInstance } from './shared.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({
  content: { dir: '.' },
  appearance: { theme: 'dark' },
  autoSync: { enabled: true },
});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type ToolHandler = (args: { key?: string; cwd?: string }) => Promise<ToolResult>;

function captureRegistration(cwd: string, configOverride?: Partial<Config>): ToolHandler {
  let captured: ToolHandler | null = null;
  const server = {
    registerTool(_name: string, _config: unknown, handler: ToolHandler) {
      captured = handler;
    },
    tool() {
      throw new Error('legacy tool() should not be called by config');
    },
  } as unknown as ServerInstance;
  register(server, {
    config: { ...BASE_CONFIG, ...configOverride },
    resolveCwd: async () => cwd,
  });
  if (!captured) throw new Error('tool not registered');
  return captured;
}

describe('config tool', () => {
  test('returns the full effective merged config when path is omitted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-config-'));
    const handler = captureRegistration(cwd);
    const result = await handler({});
    expect(result.isError).toBeUndefined();
    const value = result.structuredContent?.value as Record<string, unknown>;
    expect(value.appearance).toBeDefined();
    expect((value.content as { dir: string }).dir).toBe('.');
  });

  test('returns sub-tree when path is provided', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-config-'));
    const handler = captureRegistration(cwd);
    const result = await handler({ key: 'appearance' });
    const value = result.structuredContent?.value as { theme: string };
    expect(value.theme).toBe('dark');
  });

  test('returns scalar leaf when path resolves to a primitive', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-config-'));
    const handler = captureRegistration(cwd);
    const result = await handler({ key: 'content.dir' });
    expect(result.structuredContent?.value).toBe('.');
  });

  test('returns null + exists:false for a nonexistent path', async () => {
    // Wire-format note: `JSON.stringify(undefined)` returns the JS value
    // `undefined` rather than a JSON string, so we surface absence as
    // `{ value: null, exists: false }` and a human-readable text body.
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-config-'));
    const handler = captureRegistration(cwd);
    const result = await handler({ key: 'nonexistent.leaf' });
    expect(result.structuredContent?.value).toBeNull();
    expect(result.structuredContent?.exists).toBe(false);
    expect(result.content[0]?.text).toContain('no value at nonexistent.leaf');
  });

  test('content[0].text is JSON-serialized for agent consumption', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-config-'));
    const handler = captureRegistration(cwd);
    const result = await handler({ key: 'appearance.theme' });
    expect(result.content[0]?.text).toBe('"dark"');
  });

  test('reads any field — no allowlist gating on read', async () => {
    // Sanity-check: the read path doesn't filter fields. `appearance.theme` is
    // `agentSettable: false` (writes via Settings pane only), but reads are
    // unrestricted.
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-config-'));
    const handler = captureRegistration(cwd);
    const result = await handler({ key: 'appearance.theme' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.value).toBe('dark');
  });

  test('reflects on-disk config when caller passes a resolver that loads it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-get-config-disk-'));
    mkdirSync(join(cwd, '.ok'), { recursive: true });
    writeFileSync(join(cwd, '.ok', 'config.yml'), 'appearance:\n  theme: light\n');
    // Simulate the resolver pattern (loads on-disk config per cwd).
    const merged: Config = {
      ...BASE_CONFIG,
      appearance: { theme: 'light' },
    };
    let captured: ToolHandler | null = null;
    const server = {
      registerTool(_name: string, _cfg: unknown, h: ToolHandler) {
        captured = h;
      },
      tool() {
        throw new Error('not used');
      },
    } as unknown as ServerInstance;
    register(server, {
      config: async () => merged,
      resolveCwd: async () => cwd,
    });
    if (!captured) throw new Error('tool not registered');
    const result = await (captured as ToolHandler)({
      key: 'appearance.theme',
    });
    expect(result.structuredContent?.value).toBe('light');
  });
});

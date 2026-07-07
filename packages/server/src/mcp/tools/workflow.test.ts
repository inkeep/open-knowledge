import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import type { ServerInstance } from './shared.ts';
import { DESCRIPTION, register } from './workflow.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
type Handler = (args: {
  kind: string;
  source?: string;
  topic?: string;
  cwd?: string;
}) => Promise<ToolResult>;

function capture(cwd: string): { name: string; handler: Handler } {
  let captured: { name: string; handler: Handler } | undefined;
  const server = {
    registerTool(name: string, _cfg: unknown, handler: Handler) {
      captured = { name, handler };
    },
  } as unknown as ServerInstance;
  register(server, { config: BASE_CONFIG, resolveCwd: async () => cwd });
  if (!captured) throw new Error('not registered');
  return captured;
}

const cwd = mkdtempSync(join(tmpdir(), 'ok-workflow-test-'));
const textOf = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

describe('workflow — kind discriminator + per-kind teaching errors', () => {
  test('registers exactly one tool named "workflow"', () => {
    expect(capture(cwd).name).toBe('workflow');
    expect(DESCRIPTION).toContain('ingest');
    expect(DESCRIPTION).toContain('discover');
    expect(DESCRIPTION).toContain('wiki');
  });

  test('kind:ingest with source returns the framed ingest plan', async () => {
    const r = await capture(cwd).handler({ kind: 'ingest', source: 'https://example.com/spec' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('Where this fits'); // the workflow frame
  });

  test('kind:research with topic returns a plan', async () => {
    const r = await capture(cwd).handler({ kind: 'research', topic: 'rate limiting' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('Where this fits');
  });

  test('kind:consolidate with topic returns a plan', async () => {
    const r = await capture(cwd).handler({ kind: 'consolidate', topic: 'rate limiting' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('Where this fits');
  });

  test('kind:discover returns the Discover plan', async () => {
    const r = await capture(cwd).handler({ kind: 'discover' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('# Discover');
    expect(r.structuredContent?.previewUrl).toBeNull();
  });

  test('kind:wiki returns the Codebase Wiki plan interpolated with contentDir', async () => {
    const r = await capture(cwd).handler({ kind: 'wiki' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('# Codebase Wiki');
    // The guide is interpolated with the resolved content.dir (mirrors discover).
    expect(textOf(r)).toContain('wiki/OVERVIEW.md');
    expect(r.structuredContent?.previewUrl).toBeNull();
  });

  test('kind:ingest without source returns a teaching error', async () => {
    const r = await capture(cwd).handler({ kind: 'ingest' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('requires `source`');
  });

  test('kind:research without topic returns a teaching error', async () => {
    const r = await capture(cwd).handler({ kind: 'research' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('requires `topic`');
  });

  test('kind:consolidate without topic returns a teaching error', async () => {
    const r = await capture(cwd).handler({ kind: 'consolidate' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('requires `topic`');
  });
});

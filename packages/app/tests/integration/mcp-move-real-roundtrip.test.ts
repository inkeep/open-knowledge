/**
 * Real MCP move tool roundtrip against a live OK server.
 *
 * The unit-level mock-fetch tests for the merged `move` tool
 * globalThis.fetch — they verify the merged `move` tool builds the
 * correct HTTP body but never round-trip through a real OK server. This
 * test:
 *
 *   1. Boots a real OK server via the integration harness
 *      (createRestartableServer — ensures the same shadow-git + persistence
 *      surface as production).
 *   2. Seeds folder + backlink state on disk.
 *   3. Registers the merged `move` MCP tool with serverUrl pointing at the
 *      live server (no fetch mock).
 *   4. Invokes the tool's handler — the tool probes the filesystem to
 *      decide whether `from` is a file or folder, then fires a real HTTP
 *      POST with kind=file or kind=folder accordingly.
 *   5. Asserts the on-disk state was rewritten AND the tool's structured
 *      response carries the renamed[] / rewrittenDocs[] / previewUrls{}
 *      (folder) or previewUrl (file) shape consumers depend on.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema } from '@inkeep/open-knowledge-server';
import { register as registerMove } from '../../../server/src/mcp/tools/move';
import type { ServerInstance } from '../../../server/src/mcp/tools/shared';
import { awaitFileWatcherIndexed, createRestartableServer } from './test-harness';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface RegisteredTool {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function createCapturingServer() {
  const registrations: RegisteredTool[] = [];
  const server = {
    registerTool(
      name: string,
      config: { description?: string },
      handler: RegisteredTool['handler'],
    ) {
      registrations.push({ name, description: config.description ?? '', handler });
    },
  } as unknown as ServerInstance;
  return { server, registrations };
}

function getTool(registrations: RegisteredTool[], name: string): RegisteredTool {
  const tool = registrations.find((r) => r.name === name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool;
}

const cleanups: Array<() => Promise<void> | void> = [];
const BASE_CONFIG = ConfigSchema.parse({});

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('MCP move tool — real roundtrip against live OK server (QA-004 / QA-005)', () => {
  test('QA-004: move (folder) posts to live /api/rename-path → folder + backlinks rewrite on disk', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    // Seed: articles/{a,b,c} + a backlink-source 'index'.
    mkdirSync(join(server.contentDir, 'articles'), { recursive: true });
    writeFileSync(join(server.contentDir, 'articles', 'a.md'), '# A\n', 'utf-8');
    writeFileSync(join(server.contentDir, 'articles', 'b.md'), '# B\n', 'utf-8');
    writeFileSync(join(server.contentDir, 'articles', 'c.md'), '# C\n', 'utf-8');
    writeFileSync(
      join(server.contentDir, 'index.md'),
      '# Index\n\nLink: [[articles/a]]\n',
      'utf-8',
    );
    await Promise.all([
      awaitFileWatcherIndexed(server, 'articles/a'),
      awaitFileWatcherIndexed(server, 'articles/b'),
      awaitFileWatcherIndexed(server, 'articles/c'),
      awaitFileWatcherIndexed(server, 'index'),
    ]);

    const { server: mcp, registrations } = createCapturingServer();
    registerMove(mcp, {
      serverUrl: `http://127.0.0.1:${server.port}`,
      config: BASE_CONFIG,
      resolveCwd: async () => server.contentDir,
    });
    const tool = getTool(registrations, 'move');

    const result = await tool.handler({
      from: 'articles',
      to: 'essays',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Renamed folder articles/ → essays/');
    // Structured content carries the renamed[] + rewrittenDocs[] shape.
    const structured = result.structuredContent as {
      ok: boolean;
      renamed: Array<{ fromDocName: string; toDocName: string }>;
      rewrittenDocs: Array<{ docName: string; rewrites: number }>;
      previewUrls?: Record<string, string>;
    };
    expect(structured.ok).toBe(true);
    expect(structured.renamed).toHaveLength(3);
    const fromPaths = structured.renamed.map((r) => r.fromDocName).sort();
    expect(fromPaths).toEqual(['articles/a', 'articles/b', 'articles/c']);
    const toPaths = structured.renamed.map((r) => r.toDocName).sort();
    expect(toPaths).toEqual(['essays/a', 'essays/b', 'essays/c']);
    // Backlink-source 'index' was rewritten.
    const rewrittenNames = structured.rewrittenDocs.map((d) => d.docName);
    expect(rewrittenNames).toContain('index');

    // On-disk state matches.
    expect(existsSync(join(server.contentDir, 'essays', 'a.md'))).toBe(true);
    expect(existsSync(join(server.contentDir, 'essays', 'b.md'))).toBe(true);
    expect(existsSync(join(server.contentDir, 'essays', 'c.md'))).toBe(true);
    expect(existsSync(join(server.contentDir, 'articles', 'a.md'))).toBe(false);
    expect(existsSync(join(server.contentDir, 'articles'))).toBe(false);
    // Backlink source rewritten on disk.
    const indexBody = readFileSync(join(server.contentDir, 'index.md'), 'utf-8');
    expect(indexBody).toContain('[[essays/a]]');
    expect(indexBody).not.toContain('[[articles/a]]');
    // 30s → 60s: ubuntu-latest CI under load takes ~30s for the live-server
    // round-trip (file-watcher index + MCP tool dispatch + /api/rename-path
    // server work + on-disk rewrite + backlink rewrite). Observed CI failure
    // at 30,008ms (8ms over) on commit 8bc35fde9; matches the rename-history
    // 60s→90s precedent for runner-class slowness on rename-related tests.
    // Local repro is ~3s — wide CI multiplier intentional and proportional.
  }, 60_000);

  test('QA-005: move (document) posts to live /api/rename-path with kind:file → backlinks rewrite', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    writeFileSync(join(server.contentDir, 'auth.md'), '# Auth\n', 'utf-8');
    writeFileSync(join(server.contentDir, 'index.md'), '# Index\n\nLink: [[auth]]\n', 'utf-8');
    await Promise.all([
      awaitFileWatcherIndexed(server, 'auth'),
      awaitFileWatcherIndexed(server, 'index'),
    ]);

    const { server: mcp, registrations } = createCapturingServer();
    registerMove(mcp, {
      serverUrl: `http://127.0.0.1:${server.port}`,
      config: BASE_CONFIG,
      resolveCwd: async () => server.contentDir,
    });
    const tool = getTool(registrations, 'move');

    const result = await tool.handler({
      from: 'auth',
      to: 'sso',
    });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      ok: boolean;
      renamed: Array<{
        fromDocName: string;
        toDocName: string;
      }>;
      rewrittenDocs: Array<{ docName: string; rewrites: number }>;
    };
    expect(structured.ok).toBe(true);
    expect(structured.renamed).toEqual([
      {
        fromDocName: 'auth',
        toDocName: 'sso',
      },
    ]);
    const rewrittenNames = structured.rewrittenDocs.map((d) => d.docName);
    expect(rewrittenNames).toContain('index');

    // Disk state.
    expect(existsSync(join(server.contentDir, 'sso.md'))).toBe(true);
    expect(existsSync(join(server.contentDir, 'auth.md'))).toBe(false);
    const indexBody = readFileSync(join(server.contentDir, 'index.md'), 'utf-8');
    expect(indexBody).toContain('[[sso]]');
    expect(indexBody).not.toContain('[[auth]]');
    // 30s → 60s: ubuntu-latest CI under load takes ~30s for the live-server
    // round-trip (file-watcher index + MCP tool dispatch + /api/rename-path
    // server work + on-disk rewrite + backlink rewrite). Observed CI failure
    // at 30,008ms (8ms over) on commit 8bc35fde9; matches the rename-history
    // 60s→90s precedent for runner-class slowness on rename-related tests.
    // Local repro is ~3s — wide CI multiplier intentional and proportional.
  }, 60_000);
});

/**
 * Integration test: `.mdx` file extension is first-class end-to-end.
 *
 * Proves the extension-aware path resolver (packages/server/src/doc-extensions.ts)
 * flows through the file watcher, content filter, persistence, and API layers.
 *
 * Regression safeguard: without the extension-aware plumbing, a `.mdx` file
 * would be invisible to the watcher, and a write-back would create a sibling
 * `.md` file instead of updating the `.mdx` source.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('.mdx extension end-to-end', () => {
  test('watcher picks up a .mdx file and CRDT mirrors its content', async () => {
    const docName = `mdx-read-${crypto.randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.mdx`);
    writeFileSync(filePath, '# Hello from MDX\n\nInitial MDX content.\n', 'utf-8');
    // Give the watcher a moment to notice the new file.
    await wait(500);

    const client = await createTestClient(server.port, docName);
    try {
      await pollUntil(() => client.ytext.toString().includes('Hello from MDX'), 5000);
      expect(client.ytext.toString()).toContain('Initial MDX content');
    } finally {
      await client.cleanup();
    }
  });

  test('collision: when both .md and .mdx exist, .mdx wins and agent write targets .mdx', async () => {
    const docName = `mdx-collision-${crypto.randomUUID()}`;
    const mdPath = join(server.contentDir, `${docName}.md`);
    const mdxPath = join(server.contentDir, `${docName}.mdx`);

    // Create both files; .mdx should take precedence per industry convention.
    writeFileSync(mdPath, '# MD content\n', 'utf-8');
    writeFileSync(mdxPath, '# MDX content\n', 'utf-8');
    await wait(600); // let watcher process both events

    const client = await createTestClient(server.port, docName);
    try {
      // The CRDT should reflect the .mdx file (higher-precedence winner).
      await pollUntil(() => client.ytext.toString().includes('MDX content'), 5000);
      expect(client.ytext.toString()).not.toContain('MD content');

      await agentWriteMd(server.port, '\n\nCollision append.\n', {
        docName,
        position: 'append',
      });
      await wait(800);

      // Write-back must target the .mdx file, not the .md file.
      const mdxAfter = readFileSync(mdxPath, 'utf-8');
      const mdAfter = readFileSync(mdPath, 'utf-8');
      expect(mdxAfter).toContain('Collision append');
      expect(mdAfter).not.toContain('Collision append');
    } finally {
      await client.cleanup();
    }
  });

  test('agent write to a .mdx-backed docName writes back to the .mdx file', async () => {
    const docName = `mdx-writeback-${crypto.randomUUID()}`;
    const mdxPath = join(server.contentDir, `${docName}.mdx`);
    const mdPath = join(server.contentDir, `${docName}.md`);
    writeFileSync(mdxPath, '# Seed\n', 'utf-8');
    await wait(500);

    const client = await createTestClient(server.port, docName);
    try {
      await pollUntil(() => client.ytext.toString().includes('Seed'), 5000);

      await agentWriteMd(server.port, '\n\nAppended by agent.\n', {
        docName,
        position: 'append',
      });

      // Allow L1 debounce (200ms in tests) to fire and persist to disk.
      await wait(800);

      const mdxAfter = readFileSync(mdxPath, 'utf-8');
      expect(mdxAfter).toContain('Appended by agent');
      // Critical invariant: no shadow .md file should be created.
      expect(existsSync(mdPath)).toBe(false);
    } finally {
      await client.cleanup();
    }
  });
});

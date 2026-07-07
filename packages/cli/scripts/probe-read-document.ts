/**
 * End-to-end probe: buildReadResult flowing through the shared enrichPath
 * → readShadowLog → shadow-repo bare git reads. Confirms agent/human
 * attribution lands in the rendered output.
 *
 * Run via: `bun run packages/cli/scripts/probe-read-document.ts`
 * Not part of the test suite — a hand-runnable probe.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  buildReadResult,
  commitUpstreamImport,
  commitWip,
  initShadowRepo,
  type WriterIdentity,
} from '@inkeep/open-knowledge-server';
import simpleGit from 'simple-git';

const root = resolve(tmpdir(), `ok-probe-${Date.now()}`);
mkdirSync(root, { recursive: true });

async function main(): Promise<void> {
  // 1. Set up a real git-backed project
  const git = simpleGit(root);
  await git.init();
  await git.raw('config', 'user.name', 'Probe');
  await git.raw('config', 'user.email', 'probe@t.test');
  writeFileSync(resolve(root, 'README.md'), '# probe\n');
  await git.add('README.md');
  await git.commit('init');

  const contentDir = resolve(root, 'content');
  mkdirSync(contentDir, { recursive: true });
  writeFileSync(
    resolve(contentDir, 'auth.md'),
    `---
title: Auth
description: OAuth 2.0 flow for SSO
tags:
  - auth
  - oauth
---

# Auth

OAuth is a protocol that...
`,
  );

  // 2. Initialize the shadow repo and record some activity
  const shadow = await initShadowRepo(root);
  const branch = (await simpleGit(root).revparse(['--abbrev-ref', 'HEAD'])).trim();

  const agent: WriterIdentity = {
    id: 'agent-claude-code-7x',
    name: 'Claude (Tim)',
    email: 'agent@ok.test',
  };
  const human: WriterIdentity = {
    id: 'human-tim',
    name: 'Tim Cardona',
    email: 'tim@ok.test',
  };

  await commitWip(shadow, human, contentDir, 'initial draft of auth doc', branch);
  await wait(1100);
  writeFileSync(resolve(contentDir, 'auth.md'), '# Auth v2\n\nRewrote §3 oauth examples.\n');
  await commitWip(shadow, agent, contentDir, 'rewrite §3 oauth examples', branch);
  await wait(1100);
  writeFileSync(resolve(contentDir, 'auth.md'), '# Auth v3\n\nFixed typo.\n');
  await commitWip(shadow, human, contentDir, 'typo fix', branch);
  await wait(1100);
  // And a fake "upstream" git pull import
  const oldHead = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  const newHead = 'f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9';
  await commitUpstreamImport(shadow, contentDir, oldHead, newHead, branch);

  // 3. Call buildReadResult — the actual MCP-tool body, end to end
  const output = await buildReadResult(
    { path: 'content/auth.md' },
    {
      projectDir: root,
      serverUrl: undefined, // disk-only, no Hocuspocus → backlinkCount stays null
      config: {
        mcp: {
          tools: {
            read_document: { historyDepth: 5 },
            // biome-ignore lint/suspicious/noExplicitAny: probe-only cast; full config not needed
          } as any,
          // biome-ignore lint/suspicious/noExplicitAny: probe-only cast
        } as any,
        // biome-ignore lint/suspicious/noExplicitAny: probe-only cast
      } as any,
    },
  );

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  end-to-end probe: buildReadResult via shadow-repo');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(output);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  project root: ${root}`);
}

try {
  await main();
} finally {
  rmSync(root, { recursive: true, force: true });
}

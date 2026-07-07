/**
 * End-to-end probe: buildExecResult through the full pipeline
 * (parseCommand → just-bash → extractPaths → enrichPath → dual-channel
 * response). Hand-runnable — not part of the test suite.
 *
 * Run via: `bun run packages/cli/scripts/probe-exec.ts`
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  buildExecResult,
  commitWip,
  type ExecStructuredResult,
  initShadowRepo,
  type WriterIdentity,
} from '@inkeep/open-knowledge-server';
import simpleGit from 'simple-git';

const root = resolve(tmpdir(), `ok-exec-probe-${Date.now()}`);
mkdirSync(root, { recursive: true });

async function main(): Promise<void> {
  const git = simpleGit(root);
  await git.init();
  await git.raw('config', 'user.name', 'Probe');
  await git.raw('config', 'user.email', 'probe@t.test');
  writeFileSync(resolve(root, 'README.md'), '# probe\n');
  await git.add('README.md');
  await git.commit('init');

  const contentDir = resolve(root, 'articles');
  mkdirSync(contentDir, { recursive: true });
  writeFileSync(
    resolve(contentDir, 'auth.md'),
    '---\ntitle: Auth\ndescription: OAuth 2.0 flow\ntags:\n  - auth\n  - oauth\n---\n\n# Auth\n\nOAuth is...\n',
  );
  writeFileSync(
    resolve(contentDir, 'sso.md'),
    '---\ntitle: SSO\ntags:\n  - auth\n---\n\n# SSO\n\noauth provider...\n',
  );

  // Shadow-repo activity
  const shadow = await initShadowRepo(root);
  const branch = (await simpleGit(root).revparse(['--abbrev-ref', 'HEAD'])).trim();
  const agent: WriterIdentity = { id: 'agent-claude-7x', name: 'Claude (Tim)', email: 'a@ok.test' };
  const human: WriterIdentity = { id: 'human-tim', name: 'Tim Cardona', email: 't@ok.test' };
  await commitWip(shadow, human, contentDir, 'initial auth doc', branch);
  await wait(1100);
  writeFileSync(resolve(contentDir, 'auth.md'), '# Auth v2\n\noauth rewrite.\n');
  await commitWip(shadow, agent, contentDir, 'rewrite §3 oauth examples', branch);

  const deps = { projectDir: root, serverUrl: undefined as string | undefined };

  const runs: Array<{ label: string; cmd: string }> = [
    { label: 'cat single file (rich enrichment)', cmd: 'cat articles/auth.md' },
    { label: 'ls directory (slim enrichment each)', cmd: 'ls articles/' },
    { label: 'grep | head pipe', cmd: 'grep -rn oauth articles/ | head -5' },
    { label: 'denied: awk (unknown_command)', cmd: 'awk BEGIN{print}' },
    { label: 'denied: redirection (write_blocked)', cmd: 'cat articles/auth.md > out.txt' },
    { label: 'denied: subshell (shell_construct_blocked)', cmd: 'cat `ls`' },
  ];

  for (const { label, cmd } of runs) {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`  ${label}`);
    console.log(`  exec(${JSON.stringify(cmd)})`);
    console.log('═══════════════════════════════════════════════════════════');
    const result = (await buildExecResult({ command: cmd }, deps)) as {
      content: Array<{ text: string }>;
      structuredContent: ExecStructuredResult;
      isError?: boolean;
    };
    console.log(result.content[0].text.slice(0, 900));
    if (result.structuredContent.error) {
      console.log(`\n  [error.category] ${result.structuredContent.error.category}`);
    } else {
      console.log(`\n  [enrichedPaths] ${result.structuredContent.enrichedPaths.length} path(s)`);
      for (const m of result.structuredContent.enrichedPaths) {
        if ((m as { type?: string }).type === 'directory') {
          const d = m as {
            path: string;
            recursiveMdCount: number;
            childDirCount: number;
          };
          console.log(
            `    - ${d.path}/ (directory): ${d.recursiveMdCount} md, ${d.childDirCount} subdirs`,
          );
        } else {
          const f = m as { path: string; title?: string; historySource: unknown };
          const rich = f.historySource !== null ? ' (rich)' : '';
          console.log(`    - ${f.path}${rich}: ${f.title ?? '(no title)'}`);
        }
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
}

try {
  await main();
} finally {
  rmSync(root, { recursive: true, force: true });
}

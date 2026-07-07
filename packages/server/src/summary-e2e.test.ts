/**
 * Cross-cutting vertical-slice verification for agent-write-summaries.
 *
 * Proves the full chain: `recordContributor(summary)` → swap + format →
 * commitWip on a real shadow repo → `getDocumentHistory` → `TimelineEntry.contributors[*].summaries`.
 *
 * Skips the HTTP layer (covered by api-agent-write-summary.test.ts) and the
 * MCP transport (covered by summary-passthrough.test.ts) so this suite focuses
 * purely on the shadow-repo round-trip integrity — if this regresses, the
 * storage contract has been broken somewhere between the accumulator and the
 * read path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import simpleGit from 'simple-git';
import {
  formatContributorsFrom,
  recordContributor,
  swapContributors,
} from './contributor-tracker.ts';
import { commitWip, initShadowRepo, type WriterIdentity } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

let projectDir: string;

async function bootstrap(): Promise<string> {
  projectDir = mkdtempSync(join(tmpdir(), 'ok-summary-e2e-'));
  const git = simpleGit(projectDir);
  await git.init();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 't@t.test');
  // Ensure we have a main branch.
  const contentDir = resolve(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  writeFileSync(resolve(contentDir, 'foo.md'), '# Foo\n');
  await git.add('content/foo.md');
  await git.commit('init');
  return projectDir;
}

beforeEach(() => {
  swapContributors();
});

afterEach(() => {
  if (projectDir) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

describe('summaries round-trip: accumulator → shadow commit → timeline query', () => {
  test('single contributor with multiple summaries round-trips through the shadow log', async () => {
    const project = await bootstrap();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();

    // Simulate what the API handlers do: record per-write summaries.
    recordContributor(
      'content/foo',
      'agent-claude',
      'Claude',
      'seed-1',
      undefined,
      undefined,
      'Fixed token-refresh race',
    );
    recordContributor(
      'content/foo',
      'agent-claude',
      'Claude',
      'seed-1',
      undefined,
      undefined,
      'Added unit test',
    );
    recordContributor(
      'content/foo',
      'agent-claude',
      'Claude',
      'seed-1',
      undefined,
      undefined,
      'Tightened docstring',
    );

    // Drain like persistence.ts's commitToWipRef would.
    const snapshot = swapContributors();
    const contributorLines = formatContributorsFrom(snapshot);
    const message = `WIP auto-save 2026-04-21T00:00:00.000Z${contributorLines}`;
    const writer: WriterIdentity = {
      id: 'agent-claude',
      name: 'Claude',
      email: 'claude@agent.local',
    };
    writeFileSync(resolve(contentDir, 'foo.md'), '# Foo v2\n');
    await commitWip(shadow, writer, 'content', message, branch);

    const { entries } = await getDocumentHistory(shadow, { docName: 'foo', branch }, 'content');

    // Find the WIP entry we just wrote. `init` upstream commit may also be present.
    const wip = entries.find((e) => e.type === 'wip');
    expect(wip).toBeDefined();
    expect(wip?.contributors).toHaveLength(1);
    expect(wip?.contributors[0].id).toBe('agent-claude');
    expect(wip?.contributors[0].name).toBe('Claude');
    expect(wip?.contributors[0].summaries).toEqual([
      'Fixed token-refresh race',
      'Added unit test',
      'Tightened docstring',
    ]);
  });

  test('legacy commit (no summaries) reads back with summaries: undefined — zero regression', async () => {
    const project = await bootstrap();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();

    // Fabricate a legacy-shape body (no summaries field).
    const legacyBody = [
      'WIP auto-save 2026-04-10T00:00:00.000Z',
      '',
      'ok-contributors: {"v":1,"id":"agent-legacy","name":"Legacy","colorSeed":"x","docs":["content/foo"]}',
    ].join('\n');
    const writer: WriterIdentity = {
      id: 'agent-legacy',
      name: 'Legacy',
      email: 'legacy@agent.local',
    };
    writeFileSync(resolve(contentDir, 'foo.md'), '# Foo legacy\n');
    await commitWip(shadow, writer, 'content', legacyBody, branch);

    const { entries } = await getDocumentHistory(shadow, { docName: 'foo', branch }, 'content');
    const wip = entries.find((e) => e.type === 'wip');
    expect(wip).toBeDefined();
    expect(wip?.contributors).toHaveLength(1);
    expect(wip?.contributors[0].id).toBe('agent-legacy');
    expect(wip?.contributors[0].summaries).toBeUndefined();
  });

  test('two contributors in one commit: each emits summaries independently (D23 flat shape)', async () => {
    const project = await bootstrap();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();

    recordContributor(
      'content/foo',
      'agent-alice',
      'Alice',
      'seed-a',
      undefined,
      undefined,
      'Cleaned up intro',
    );
    recordContributor(
      'content/foo',
      'agent-bob',
      'Bob',
      'seed-b',
      undefined,
      undefined,
      'Fixed footer link',
    );
    recordContributor(
      'content/foo',
      'agent-alice',
      'Alice',
      'seed-a',
      undefined,
      undefined,
      'Added example',
    );

    const snapshot = swapContributors();
    const contributorLines = formatContributorsFrom(snapshot);
    const message = `WIP auto-save 2026-04-21T00:00:05.000Z${contributorLines}`;
    const writer: WriterIdentity = { id: 'agent-alice', name: 'Alice', email: 'a@a.test' };
    writeFileSync(resolve(contentDir, 'foo.md'), '# Foo multi\n');
    await commitWip(shadow, writer, 'content', message, branch);

    const { entries } = await getDocumentHistory(shadow, { docName: 'foo', branch }, 'content');
    const wip = entries.find((e) => e.type === 'wip');
    expect(wip).toBeDefined();
    expect(wip?.contributors).toHaveLength(2);

    const byId = Object.fromEntries(
      wip?.contributors.map((c) => [c.id, c.summaries ?? null]) ?? [],
    );
    expect(byId['agent-alice']).toEqual(['Cleaned up intro', 'Added example']);
    expect(byId['agent-bob']).toEqual(['Fixed footer link']);
  });

  test('summary-less writes from one contributor coexist with summaried writes from another', async () => {
    const project = await bootstrap();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();

    recordContributor(
      'content/foo',
      'agent-a',
      'A',
      'seed-a',
      undefined,
      undefined,
      'With summary',
    );
    recordContributor('content/foo', 'agent-b', 'B', 'seed-b'); // no summary

    const snapshot = swapContributors();
    const contributorLines = formatContributorsFrom(snapshot);
    const message = `WIP auto-save 2026-04-21T00:00:10.000Z${contributorLines}`;
    const writer: WriterIdentity = { id: 'agent-a', name: 'A', email: 'a@a.test' };
    writeFileSync(resolve(contentDir, 'foo.md'), '# Foo mixed\n');
    await commitWip(shadow, writer, 'content', message, branch);

    const { entries } = await getDocumentHistory(shadow, { docName: 'foo', branch }, 'content');
    const wip = entries.find((e) => e.type === 'wip');
    expect(wip).toBeDefined();
    expect(wip?.contributors).toHaveLength(2);
    const aEntry = wip?.contributors.find((c) => c.id === 'agent-a');
    const bEntry = wip?.contributors.find((c) => c.id === 'agent-b');
    expect(aEntry?.summaries).toEqual(['With summary']);
    // The summary-less contributor must have NO `summaries` key on the wire,
    // which parseContributors surfaces as `undefined`. Byte-identical to legacy.
    expect(bEntry?.summaries).toBeUndefined();
  });
});


import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment } from '@tiptap/y-tiptap';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertAllConverged,
  awaitDocQuiescence,
  createTestClient,
  createTestClients,
  createTestServer,
  getServerState,
  mdManager,
  pollDiskContentStable,
  schema,
  type TestClient,
  type TestServer,
} from './test-harness';

const STEPS = [
  '<Steps>',
  '',
  '<Step>',
  '',
  'Content one.',
  '',
  '</Step>',
  '',
  '<Step>',
  '',
  'Content two.',
  '',
  '</Step>',
  '',
  '</Steps>',
  '',
].join('\n');

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function applyWysiwygEdit(client: TestClient, markdownAfterEdit: string): void {
  const pmNode = schema.nodeFromJSON(mdManager.parse(markdownAfterEdit));
  client.doc.transact(() => {
    updateYFragment(client.doc, client.fragment, pmNode, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  });
}

const INDENTED_STEP = /\n[ \t]+<\/?Step\b/;
const INDENTED_STEPS = /\n[ \t]+<\/?Steps\b/;

describe('bug #3 — source-mode write-back guard (re-indent facet closed by #1991)', () => {
  test('the faithful <Steps> parses to a jsxComponent and is a serialize fixed point', () => {
    const tree = mdManager.parse(STEPS) as { content?: Array<{ type?: string }> };
    const topTypes = (tree.content ?? []).map((n) => n.type);
    expect(topTypes).toContain('jsxComponent');
    expect(mdManager.serialize(mdManager.parse(STEPS))).toBe(
      '<Steps>\n\n<Step>\n\nContent one.\n\n</Step>\n\n<Step>\n\nContent two.\n\n</Step>\n\n</Steps>\n',
    );
  });

  test('V1 baseline: an isolated source keystroke stays byte-verbatim (no Observer-A write-back)', async () => {
    const docName = `bug3-v1-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, STEPS, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      const ytext = client.doc.getText('source');
      await awaitDocQuiescence(client.doc);
      expect(ytext.toString()).toBe(STEPS);
      const at = ytext.toString().indexOf('Content one.') + 'Content one'.length;
      client.doc.transact(() => ytext.insert(at, 'X'));
      const expected = ytext.toString();
      await awaitDocQuiescence(client.doc);
      expect(getServerState(server, docName)?.ytext.toString()).toBe(expected);
    } finally {
      await client.cleanup();
    }
  });

  test('a concurrent WYSIWYG fragment commit does NOT re-indent the <Steps> in Y.Text', async () => {
    const docName = `bug3-writeback-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, STEPS, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      const ytext = client.doc.getText('source');
      await awaitDocQuiescence(client.doc);
      expect(ytext.toString()).toBe(STEPS);

      applyWysiwygEdit(client, STEPS.replace('Content two.', 'Content two, edited.'));
      await awaitDocQuiescence(client.doc);

      const after = getServerState(server, docName)?.ytext.toString() ?? '';
      expect(after).toContain('Content two, edited.');
      expect(after).not.toMatch(INDENTED_STEP);
      expect(after).not.toMatch(INDENTED_STEPS);
    } finally {
      await client.cleanup();
    }
  });
});

const FENCE = '`'.repeat(3);

async function seedAndEdit(docName: string, seed: string, edited: string): Promise<string> {
  await agentWriteMd(server.port, seed, { docName, position: 'replace' });
  await wait(300);
  const client = await createTestClient(server.port, docName);
  try {
    const ytext = client.doc.getText('source');
    await awaitDocQuiescence(client.doc);
    expect(ytext.toString()).toBe(seed);
    applyWysiwygEdit(client, edited);
    await awaitDocQuiescence(client.doc);
    return getServerState(server, docName)?.ytext.toString() ?? '';
  } finally {
    await client.cleanup();
  }
}

describe('QA canary — Steps live-edit fidelity (Observer-A altitude)', () => {
  test('fenced code block with 4-space interior inside a Step survives a WYSIWYG edit', async () => {
    const seed = [
      '<Steps>',
      '',
      '<Step>',
      '',
      'Intro one.',
      '',
      `${FENCE}js`,
      'const x = 1;',
      '    deepIndented();',
      FENCE,
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      'Content two.',
      '',
      '</Step>',
      '',
      '</Steps>',
      '',
    ].join('\n');
    const edited = seed.replace('Content two.', 'Content two, edited.');
    const after = await seedAndEdit(`canary-fence-${crypto.randomUUID()}`, seed, edited);

    expect(after).toContain('Content two, edited.');
    expect(after).toContain('\n    deepIndented();');
    expect(after).not.toContain('&#x20;deepIndented');
    expect(after).not.toContain('&#x9;');
    expect(after).not.toMatch(INDENTED_STEP);
    expect(after).not.toMatch(INDENTED_STEPS);
    expect((after.match(/```/g) ?? []).length).toBe(2);
  });

  test('strike and highlight marks inside a Step are not silently dropped', async () => {
    const seed = [
      '<Steps>',
      '',
      '<Step>',
      '',
      'Plain intro.',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      'Has ~~struck~~ and ==marked== words.',
      '',
      '</Step>',
      '',
      '</Steps>',
      '',
    ].join('\n');
    const edited = seed.replace('Plain intro.', 'Plain intro, edited.');
    const after = await seedAndEdit(`canary-marks-${crypto.randomUUID()}`, seed, edited);

    expect(after).toContain('Plain intro, edited.');
    expect(after).toContain('~~struck~~');
    expect(after).toContain('==marked==');
    expect(after).not.toMatch(INDENTED_STEP);
  });

  test('ordered list inside a Step: no item loss or duplication, tags stay flush-left', async () => {
    const seed = [
      '<Steps>',
      '',
      '<Step>',
      '',
      'Do these:',
      '',
      '1. first',
      '2. second',
      '3. third',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      'After.',
      '',
      '</Step>',
      '',
      '</Steps>',
      '',
    ].join('\n');
    const edited = seed.replace('After.', 'After, edited.');
    const after = await seedAndEdit(`canary-list-${crypto.randomUUID()}`, seed, edited);

    expect(after).toContain('After, edited.');
    expect(after).toContain('first');
    expect(after).toContain('second');
    expect(after).toContain('third');
    expect((after.match(/\bfirst\b/g) ?? []).length).toBe(1);
    expect((after.match(/\bsecond\b/g) ?? []).length).toBe(1);
    expect((after.match(/\bthird\b/g) ?? []).length).toBe(1);
    expect(after).not.toMatch(INDENTED_STEP);
    expect(after).not.toMatch(INDENTED_STEPS);
  });

  test('github-sync 4-Step shape (flush-left tags, indented bodies): edit one body, no corruption', async () => {
    const seed = [
      '<Steps>',
      '',
      '<Step>',
      '',
      '### Connect',
      '',
      '    Link your repo to start syncing.',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      '### Configure',
      '',
      '    Choose a branch and a folder.',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      '### Sync',
      '',
      '    Changes flow both ways.',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      '### Done',
      '',
      '    Your docs are live.',
      '',
      '</Step>',
      '',
      '</Steps>',
      '',
    ].join('\n');
    const edited = seed.replace(
      'Choose a branch and a folder.',
      'Choose a branch and a folder to sync.',
    );
    const before = mdManager.serialize(mdManager.parse(seed));
    const after = await seedAndEdit(`canary-gh-${crypto.randomUUID()}`, before, edited);

    expect(after).toContain('Choose a branch and a folder to sync.');
    expect((after.match(/<Steps>/g) ?? []).length).toBe(1);
    expect((after.match(/<Step>/g) ?? []).length).toBe(4);
    expect(after).not.toMatch(INDENTED_STEP);
    expect(after.length).toBeLessThan(before.length + 64);
  });
});

describe('QA canary — cold-reopen / concurrent-peer / idempotence (Observer-A altitude)', () => {
  test('cold reopen: 4-Step github-sync shape edited via WYSIWYG, disk bytes uncorrupted + match memory', async () => {
    const docName = `canary-cold-${crypto.randomUUID()}`;
    const seed = mdManager.serialize(
      mdManager.parse(
        [
          '<Steps>',
          '',
          '<Step>',
          '',
          '### Connect',
          '',
          'Link your repo.',
          '',
          '</Step>',
          '',
          '<Step>',
          '',
          '### Configure',
          '',
          'Choose a branch.',
          '',
          '</Step>',
          '',
          '<Step>',
          '',
          '### Sync',
          '',
          'Changes flow both ways.',
          '',
          '</Step>',
          '',
          '</Steps>',
          '',
        ].join('\n'),
      ),
    );
    await agentWriteMd(server.port, seed, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      await awaitDocQuiescence(client.doc);
      applyWysiwygEdit(client, seed.replace('Choose a branch.', 'Choose a branch and folder.'));
      await awaitDocQuiescence(client.doc);

      const diskPath = join(server.contentDir, `${docName}.md`);
      const disk = await pollDiskContentStable(diskPath, (c) =>
        c.includes('Choose a branch and folder.'),
      );
      const memory = getServerState(server, docName)?.ytext.toString() ?? '';

      expect(disk).toContain('Choose a branch and folder.');
      expect(disk).not.toMatch(INDENTED_STEP);
      expect((disk.match(/<Steps>/g) ?? []).length).toBe(1);
      expect((disk.match(/<Step>/g) ?? []).length).toBe(3);
      expect(disk.length).toBeLessThan(seed.length + 64);
      expect(disk.trimEnd()).toBe(memory.trimEnd());
    } finally {
      await client.cleanup();
    }
  });

  test('concurrent peers typing into different Steps converge with both edits, no dup', async () => {
    const docName = `canary-concurrent-${crypto.randomUUID()}`;
    const seed = [
      '<Steps>',
      '',
      '<Step>',
      '',
      'Content one.',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      'Content two.',
      '',
      '</Step>',
      '',
      '</Steps>',
      '',
    ].join('\n');
    await agentWriteMd(server.port, seed, { docName, position: 'replace' });
    await wait(300);
    const clients = await createTestClients(server.port, { count: 2, docName });
    try {
      await assertAllConverged(clients, { timeout: 5000 });
      const a = clients[0].ytext;
      const b = clients[1].ytext;
      clients[0].doc.transact(() =>
        a.insert(a.toString().indexOf('Content one.') + 'Content one'.length, ' (A)'),
      );
      clients[1].doc.transact(() =>
        b.insert(b.toString().indexOf('Content two.') + 'Content two'.length, ' (B)'),
      );
      await assertAllConverged(clients, { timeout: 5000 });

      const after = clients[0].ytext.toString();
      expect(after).toContain('(A)');
      expect(after).toContain('(B)');
      expect((after.match(/<Step>/g) ?? []).length).toBe(2);
      expect((after.match(/Content one/g) ?? []).length).toBe(1);
      expect((after.match(/Content two/g) ?? []).length).toBe(1);
      expect(after).not.toMatch(INDENTED_STEP);
    } finally {
      await Promise.all(clients.map((c) => c.cleanup()));
    }
  });

  test('repeated identical WYSIWYG drain on a <Steps> doc is idempotent (no growth/drift)', async () => {
    const docName = `canary-idem-${crypto.randomUUID()}`;
    const seed = [
      '<Steps>',
      '',
      '<Step>',
      '',
      'Alpha.',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      'Beta.',
      '',
      '</Step>',
      '',
      '</Steps>',
      '',
    ].join('\n');
    await agentWriteMd(server.port, seed, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      await awaitDocQuiescence(client.doc);
      const edited = seed.replace('Alpha.', 'Alpha, edited.');
      applyWysiwygEdit(client, edited);
      await awaitDocQuiescence(client.doc);
      const s1 = getServerState(server, docName)?.ytext.toString() ?? '';
      applyWysiwygEdit(client, edited);
      await awaitDocQuiescence(client.doc);
      const s2 = getServerState(server, docName)?.ytext.toString() ?? '';

      expect(s1).toContain('Alpha, edited.');
      expect(s2).toBe(s1);
      expect((s2.match(/<Step>/g) ?? []).length).toBe(2);
    } finally {
      await client.cleanup();
    }
  });
});

const OK_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const GITHUB_SYNC = join(OK_ROOT, 'docs', 'content', 'features', 'github-sync.mdx');
const QUICKSTART = join(OK_ROOT, 'docs', 'content', 'get-started', 'quickstart.mdx');

describe('QA canary — real repo docs with <Steps>', () => {
  test('github-sync.mdx loads byte-clean through the bridge (frontmatter + Callout + Steps intact)', async () => {
    const md = readFileSync(GITHUB_SYNC, 'utf-8');
    expect(md).toContain('title: GitHub sync');
    expect((md.match(/^<Step>$/gm) ?? []).length).toBe(4);
    expect(md).toMatch(/^<Steps>$/m);
    expect(md).toMatch(/\n {4}### /);
    expect(md).not.toMatch(INDENTED_STEP);

    const docName = `real-gh-load-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, md, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      await awaitDocQuiescence(client.doc);
      const ytext = client.doc.getText('source').toString();
      expect(ytext).toContain('title: GitHub sync');
      expect(ytext).toContain('<Callout type="warn">');
      expect((ytext.match(/^<Step>$/gm) ?? []).length).toBe(4);
      expect(ytext).not.toMatch(INDENTED_STEP);
      expect(ytext).toMatch(/\n {4}### Open the clone dialog/);
      expect(mdManager.serialize(mdManager.parse(ytext))).toBe(
        mdManager.serialize(mdManager.parse(md)),
      );
    } finally {
      await client.cleanup();
    }
  });

  test('live source edit inside a real Step fires no Observer-A re-indent; disk cold-reopen clean', async () => {
    const md = readFileSync(GITHUB_SYNC, 'utf-8');
    const docName = `real-gh-edit-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, md, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      const ytext = client.doc.getText('source');
      await awaitDocQuiescence(client.doc);
      const anchor = 'Paste a repository URL';
      const at = ytext.toString().indexOf(anchor) + anchor.length;
      expect(at).toBeGreaterThan(anchor.length);
      client.doc.transact(() => ytext.insert(at, ' (edited)'));
      await awaitDocQuiescence(client.doc);

      const memory = getServerState(server, docName)?.ytext.toString() ?? '';
      expect(memory).toContain('Paste a repository URL (edited)');
      expect(memory).not.toMatch(INDENTED_STEP);
      expect((memory.match(/^<Step>$/gm) ?? []).length).toBe(4);
      expect(memory).toContain('title: GitHub sync');
      expect(memory.length).toBeLessThan(md.length + 32);

      const disk = await pollDiskContentStable(join(server.contentDir, `${docName}.md`), (c) =>
        c.includes('Paste a repository URL (edited)'),
      );
      expect(disk).not.toMatch(INDENTED_STEP);
      expect((disk.match(/^<Step>$/gm) ?? []).length).toBe(4);
      expect(disk.trimEnd()).toBe(memory.trimEnd());
    } finally {
      await client.cleanup();
    }
  });

  test('quickstart.mdx (Steps + Tabs) loads byte-clean through the bridge', async () => {
    const md = readFileSync(QUICKSTART, 'utf-8');
    const docName = `real-qs-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, md, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      await awaitDocQuiescence(client.doc);
      const ytext = client.doc.getText('source').toString();
      expect(ytext).toMatch(/^<Steps>$/m);
      expect(ytext).not.toMatch(INDENTED_STEP);
      expect(mdManager.serialize(mdManager.parse(ytext))).toBe(
        mdManager.serialize(mdManager.parse(md)),
      );
    } finally {
      await client.cleanup();
    }
  });
});

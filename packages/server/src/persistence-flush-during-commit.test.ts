import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { recordContributor, swapContributors } from './contributor-tracker.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import { createPersistenceExtension } from './persistence.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';

const commitGate = vi.hoisted(() => ({
  next: undefined as undefined | { entered: () => void; release: Promise<void> },
}));

vi.mock('./shadow-repo.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shadow-repo.ts')>();
  return {
    ...actual,
    commitWipFromTree: async (...args: Parameters<typeof actual.commitWipFromTree>) => {
      const gate = commitGate.next;
      commitGate.next = undefined;
      if (gate) {
        gate.entered();
        await gate.release;
      }
      return actual.commitWipFromTree(...args);
    },
  };
});

const EARLIER = { id: 'principal-earlier', name: 'Earlier' };
const TYPIST = { id: 'principal-typist', name: 'Typist' };

let tmpDir: string;
let contentDir: string;
let shadow: ShadowHandle;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-flush-during-commit-'));
  contentDir = join(tmpDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  shadow = await initShadowRepo(tmpDir);
  swapContributors();
});

afterEach(() => {
  commitGate.next = undefined;
  swapContributors();
  rmSync(tmpDir, { recursive: true, force: true });
});

function replaceBody(document: Y.Doc, text: string): void {
  const fragment = document.getXmlFragment('default');
  const ytext = document.getText('source');
  document.transact(() => {
    fragment.delete(0, fragment.length);
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(text)]);
    fragment.insert(0, [paragraph]);
    ytext.delete(0, ytext.length);
    ytext.insert(0, `${text}\n`);
  });
}

async function wipHead(writerId: string): Promise<string> {
  return (
    await shadowGit(shadow).raw(
      'for-each-ref',
      '--format=%(objectname)',
      `refs/wip/main/${writerId}`,
    )
  ).trim();
}

test.each([
  { timer: 'still armed', commitDebounceMs: 600_000, waitForTimer: false },
  { timer: 'already fired', commitDebounceMs: 300, waitForTimer: true },
])(
  'a flush while a WIP commit runs commits the writers recorded after it began (timer $timer)',
  async ({ commitDebounceMs, waitForTimer }) => {
    writeFileSync(join(contentDir, 'notes.md'), 'initial\n');
    const persistence = createPersistenceExtension({
      contentDir,
      projectDir: tmpDir,
      contentRoot: 'content',
      shadowRef: { current: shadow },
      commitDebounceMs,
      durabilityState: new DocumentDurabilityState(),
    });
    const document = new Y.Doc();
    await persistence.extension.onLoadDocument?.({
      document,
      documentName: 'notes',
      context: {},
    } as never);

    let entered = () => {};
    let release = () => {};
    const reachedCommit = new Promise<void>((resolve) => {
      entered = resolve;
    });
    commitGate.next = {
      entered,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };

    recordContributor('notes', EARLIER.id, EARLIER.name, EARLIER.id);
    replaceBody(document, 'first edit');
    await persistence.forceStore(document, 'notes');
    const runningCommit = persistence.flushPendingGitCommit();
    await reachedCommit;

    recordContributor('notes', TYPIST.id, TYPIST.name, TYPIST.id);
    replaceBody(document, 'second edit');
    await persistence.forceStore(document, 'notes');
    if (waitForTimer) await sleep(commitDebounceMs * 3);
    const flush = persistence.flushPendingGitCommit();
    release();
    await Promise.all([runningCommit, flush]);

    expect(await wipHead(EARLIER.id)).toMatch(/^[0-9a-f]{40}$/);
    const typistHead = await wipHead(TYPIST.id);
    expect(typistHead).toMatch(/^[0-9a-f]{40}$/);
    expect(await shadowGit(shadow).raw('show', `${typistHead}:content/notes.md`)).toBe(
      'second edit\n',
    );

    document.destroy();
  },
);

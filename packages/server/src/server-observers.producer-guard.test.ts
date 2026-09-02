import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { getLogger } from './logger.ts';
import { getMetrics } from './metrics.ts';
import {
  ProducerGuardViolationError,
  type SetupServerObserversOpts,
  setupServerObservers,
} from './server-observers.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

const LOSS_SENTINEL = 'ZZLOSSZZ';

const PRODUCER_GUARD_COOLDOWN_MS = 5_000;

const DANGER_TABLE_MD = `| Col |\n| --- |\n| ${LOSS_SENTINEL} keep |\n`;
const LEGAL_TABLE_MD = `| Col |\n| --- |\n| keep only |\n`;
const PLAIN_MD = `${LOSS_SENTINEL} plain paragraph\n`;

function createDoc() {
  const doc = new Y.Doc();
  return { doc, xmlFragment: doc.getXmlFragment('default'), ytext: doc.getText('source') };
}

function seedFragmentJson(doc: Y.Doc, xmlFragment: Y.XmlFragment, json: unknown): void {
  const pmNode = schema.nodeFromJSON(json);
  doc.transact(() => {
    updateYFragment(doc, xmlFragment, pmNode, { mapping: new Map(), isOMark: new Map() });
  }, null);
}

function seedFragment(doc: Y.Doc, xmlFragment: Y.XmlFragment, md: string): void {
  seedFragmentJson(doc, xmlFragment, mdManager.parse(md));
}

const CONTAINER_WITH_FALLBACK_CHILD = {
  type: 'doc',
  content: [
    {
      type: 'jsxComponent',
      attrs: {
        componentName: 'Callout',
        kind: 'element',
        attributes: [],
        sourceRaw: '<Callout>\n\n<Step>\n\n**bold** step\n\n</Step>\n\n</Callout>',
        sourceDirty: true,
        props: { type: 'info' },
      },
      content: [
        {
          type: 'rawMdxFallback',
          attrs: { reason: 'Unregistered component: Step' },
          content: [{ type: 'text', text: '<Step>\n\n**bold** step\n\n</Step>' }],
        },
      ],
    },
  ],
};

function makeContentLosingManager(dropText: string): MarkdownManager {
  return new Proxy(mdManager, {
    get(target, prop, receiver) {
      if (prop === 'serialize') {
        return (json: Parameters<MarkdownManager['serialize']>[0]) =>
          target.serialize(json).split(dropText).join('');
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function makeContainerShatteringManager(): MarkdownManager {
  return new Proxy(mdManager, {
    get(target, prop, receiver) {
      if (prop === 'serialize') {
        return (json: Parameters<MarkdownManager['serialize']>[0]) =>
          target
            .serialize(json)
            .split('\n')
            .filter((line) => !/^\s*<\/?Callout/.test(line))
            .join('\n');
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function baseOpts(
  o: { doc: Y.Doc; xmlFragment: Y.XmlFragment; ytext: Y.Text } & Partial<SetupServerObserversOpts>,
): SetupServerObserversOpts {
  const { doc, xmlFragment, ytext, ...rest } = o;
  return { doc, xmlFragment, ytext, mdManager, schema, ...rest };
}

function fragmentJsonString(xmlFragment: Y.XmlFragment): string {
  return JSON.stringify(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON());
}

async function waitForCheckpointRefs(shadow: ShadowHandle, timeoutMs = 3000): Promise<string[]> {
  const sg = shadowGit(shadow);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = (await sg.raw('for-each-ref', '--format=%(refname)', 'refs/checkpoints/')).trim();
    if (out) return out.split('\n');
    if (Date.now() >= deadline) return [];
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Producer guard (FR6) — dev/test posture throws (M2)', () => {
  test('content-losing serialize on a danger-space doc throws ProducerGuardViolationError at the drain', () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const cleanup = setupServerObservers(
      baseOpts({ doc, xmlFragment, ytext, mdManager: losing, docName: 'loss.md' }),
    );
    try {
      let thrown: unknown;
      try {
        seedFragment(doc, xmlFragment, DANGER_TABLE_MD);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ProducerGuardViolationError);
      expect((thrown as ProducerGuardViolationError).info.reason).toBe('content-loss');
    } finally {
      cleanup();
    }
  });

  test('faithful serialize on the same danger space does NOT fire (non-vacuity control)', () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const cleanup = setupServerObservers(
      baseOpts({ doc, xmlFragment, ytext, docName: 'legal.md' }),
    );
    try {
      expect(() => seedFragment(doc, xmlFragment, LEGAL_TABLE_MD)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  test('danger-space gate: a content-losing serialize on a plain doc is skipped (no fire)', () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const cleanup = setupServerObservers(
      baseOpts({ doc, xmlFragment, ytext, mdManager: losing, docName: 'plain.md' }),
    );
    try {
      expect(() => seedFragment(doc, xmlFragment, PLAIN_MD)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  test('a faithful serialize of a container holding a rawMdxFallback does NOT fire', () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const cleanup = setupServerObservers(
      baseOpts({ doc, xmlFragment, ytext, docName: 'fallback.md' }),
    );
    try {
      expect(() => seedFragmentJson(doc, xmlFragment, CONTAINER_WITH_FALLBACK_CHILD)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  test('a container-shatter (text preserved, container gone) does NOT fire — silent on shatter', () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const shattering = makeContainerShatteringManager();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanup = setupServerObservers(
      baseOpts({ doc, xmlFragment, ytext, mdManager: shattering, docName: 'shatter.md' }),
    );
    try {
      expect(() =>
        seedFragment(doc, xmlFragment, '<Callout type="info">\n\nkeep this text\n\n</Callout>\n'),
      ).not.toThrow();
      const fired = warn.mock.calls
        .map((call) => String(call[0]))
        .some((line) => line.includes('producer-guard-violation'));
      expect(fired).toBe(false);
    } finally {
      warn.mockRestore();
      cleanup();
    }
  });
});

describe('Producer guard (FR6) — packaged posture logs + checkpoints, never throws/corrects (QA-010)', () => {
  const SAVED_ENV = ['NODE_ENV', 'OK_RETHROW_BRIDGE_LOSS'] as const;
  let savedEnv: Partial<Record<(typeof SAVED_ENV)[number], string | undefined>>;
  let projectRoot: string;
  let shadow: ShadowHandle;

  beforeEach(async () => {
    savedEnv = {};
    for (const key of SAVED_ENV) savedEnv[key] = process.env[key];
    process.env.NODE_ENV = 'production';
    delete process.env.OK_RETHROW_BRIDGE_LOSS;

    projectRoot = await mkdtemp(resolve(tmpdir(), 'ok-producer-guard-'));
    mkdirSync(resolve(projectRoot, 'content'), { recursive: true });
    const git = simpleGit(projectRoot);
    await git.init();
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    shadow = await initShadowRepo(projectRoot);
  });

  afterEach(async () => {
    for (const key of SAVED_ENV) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(projectRoot, { recursive: true, force: true });
  });

  test('detects content-loss without throwing: structured log + silent checkpoint, no corrective write', async () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanup = setupServerObservers(
      baseOpts({
        doc,
        xmlFragment,
        ytext,
        mdManager: losing,
        docName: 'loss.md',
        shadow: () => shadow,
        contentRoot: 'content',
        getBranch: () => 'main',
      }),
    );
    try {
      expect(() => seedFragment(doc, xmlFragment, DANGER_TABLE_MD)).not.toThrow();

      const event = warn.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('producer-guard-violation'));
      expect(event).toBeDefined();
      expect(event as string).not.toContain(LOSS_SENTINEL);
      const parsed = JSON.parse(event as string);
      expect(parsed).toMatchObject({
        event: 'producer-guard-violation',
        docName: 'loss.md',
        reason: 'content-loss',
      });
      expect(typeof parsed.construct).toBe('string');
      expect(parsed.construct.length).toBeGreaterThan(0);
      expect(parsed.construct).not.toContain(LOSS_SENTINEL);

      expect(fragmentJsonString(xmlFragment)).toContain(LOSS_SENTINEL);
      expect(ytext.toString()).not.toContain(LOSS_SENTINEL);

      const refs = await waitForCheckpointRefs(shadow);
      expect(refs.length).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
      cleanup();
    }
  });

  test('a container holding a rawMdxFallback logs nothing and leaves no surfaced checkpoint', async () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanup = setupServerObservers(
      baseOpts({
        doc,
        xmlFragment,
        ytext,
        docName: 'fallback.md',
        shadow: () => shadow,
        contentRoot: 'content',
        getBranch: () => 'main',
      }),
    );
    try {
      expect(() => seedFragmentJson(doc, xmlFragment, CONTAINER_WITH_FALLBACK_CHILD)).not.toThrow();
      const fired = warn.mock.calls
        .map((call) => String(call[0]))
        .some((line) => line.includes('producer-guard-violation'));
      expect(fired).toBe(false);
      expect(await waitForCheckpointRefs(shadow, 1500)).toEqual([]);
    } finally {
      warn.mockRestore();
      cleanup();
    }
  });

  test('two distinct losses in the cooldown: one log suppressed, BOTH checkpointed, next emit carries the suppressed count', async () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const cleanup = setupServerObservers(
      baseOpts({
        doc,
        xmlFragment,
        ytext,
        mdManager: losing,
        docName: 'throttle.md',
        shadow: () => shadow,
        contentRoot: 'content',
        getBranch: () => 'main',
      }),
    );
    const violations = (): Array<{ suppressedSincePrevious: number }> =>
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('producer-guard-violation'))
        .map((line) => JSON.parse(line));
    const pollCheckpointRefs = async (minCount: number, tries = 80): Promise<string[]> => {
      const sg = shadowGit(shadow);
      let refs: string[] = [];
      for (let i = 0; i < tries; i++) {
        const out = (
          await sg.raw('for-each-ref', '--format=%(refname)', 'refs/checkpoints/')
        ).trim();
        refs = out ? out.split('\n') : [];
        if (refs.length >= minCount) return refs;
        await new Promise((r) => setTimeout(r, 25));
      }
      return refs;
    };
    const cell = (keep: string): string => `| Col |\n| --- |\n| ${LOSS_SENTINEL} ${keep} |\n`;
    try {
      seedFragment(doc, xmlFragment, cell('keepA'));
      seedFragment(doc, xmlFragment, cell('keepB'));
      expect(violations()).toHaveLength(1);
      expect(violations()[0]?.suppressedSincePrevious).toBe(0);

      const refs = await pollCheckpointRefs(2);
      expect(refs.length).toBeGreaterThanOrEqual(2);

      clock += PRODUCER_GUARD_COOLDOWN_MS + 1;
      seedFragment(doc, xmlFragment, cell('keepC'));
      const v = violations();
      expect(v).toHaveLength(2);
      expect(v[1]?.suppressedSincePrevious).toBe(1);
      expect((await pollCheckpointRefs(3)).length).toBeGreaterThanOrEqual(3);
    } finally {
      nowSpy.mockRestore();
      warn.mockRestore();
      cleanup();
    }
  });

  test('without a shadow repo, the violation log still fires (detection is not gated on checkpointing)', () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanup = setupServerObservers(
      baseOpts({ doc, xmlFragment, ytext, mdManager: losing, docName: 'no-shadow.md' }),
    );
    try {
      expect(() => seedFragment(doc, xmlFragment, DANGER_TABLE_MD)).not.toThrow();
      const event = warn.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('producer-guard-violation'));
      expect(event).toBeDefined();
      expect(JSON.parse(event as string)).toMatchObject({
        event: 'producer-guard-violation',
        docName: 'no-shadow.md',
        reason: 'content-loss',
      });
    } finally {
      warn.mockRestore();
      cleanup();
    }
  });

  const cellBody = (keep: string): string => `| Col |\n| --- |\n| ${LOSS_SENTINEL} ${keep} |\n`;
  function restoreYtext(o: { doc: Y.Doc; ytext: Y.Text }, contents: string): void {
    o.doc.transact(() => {
      o.ytext.delete(0, o.ytext.length);
      o.ytext.insert(0, contents);
    }, 'test-external-peer');
  }

  test('an identical pre-loss source is checkpointed once — the dedup map holds (one ref, one counter)', async () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const cleanup = setupServerObservers(
      baseOpts({
        doc,
        xmlFragment,
        ytext,
        mdManager: losing,
        docName: 'dedup.md',
        shadow: () => shadow,
        contentRoot: 'content',
        getBranch: () => 'main',
      }),
    );
    const createdEvents = (): number =>
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('producer-guard-checkpoint-created')).length;
    const waitForCreatedEvents = async (count: number, tries = 120): Promise<number> => {
      for (let i = 0; i < tries; i++) {
        if (createdEvents() >= count) return createdEvents();
        await new Promise((r) => setTimeout(r, 25));
      }
      return createdEvents();
    };
    try {
      seedFragment(doc, xmlFragment, PLAIN_MD);
      const lastGood = ytext.toString();
      seedFragment(doc, xmlFragment, cellBody('keepA'));
      expect((await waitForCheckpointRefs(shadow)).length).toBe(1);
      expect(await waitForCreatedEvents(1)).toBe(1);
      const counterAfterFirst = getMetrics().producerGuardCheckpointCreated;
      restoreYtext({ doc, ytext }, lastGood);
      expect(ytext.toString()).toBe(lastGood);
      clock += 2_001;
      seedFragment(doc, xmlFragment, cellBody('keepB'));
      await new Promise((r) => setTimeout(r, 400));
      expect((await waitForCheckpointRefs(shadow)).length).toBe(1);
      expect(createdEvents()).toBe(1);
      expect(getMetrics().producerGuardCheckpointCreated).toBe(counterAfterFirst);
    } finally {
      nowSpy.mockRestore();
      warn.mockRestore();
      cleanup();
    }
  });

  test('a FAILED checkpoint write reopens the retry window (dedup entry cleared on failure)', async () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logWarn = vi.spyOn(getLogger('server-observers'), 'warn');
    const brokenRoot = await mkdtemp(resolve(tmpdir(), 'ok-producer-guard-broken-'));
    mkdirSync(resolve(brokenRoot, 'content'), { recursive: true });
    const brokenGit = simpleGit(brokenRoot);
    await brokenGit.init();
    await brokenGit.raw('config', 'user.name', 'Test');
    await brokenGit.raw('config', 'user.email', 'test@test.com');
    const brokenShadow = await initShadowRepo(brokenRoot);
    await rm(brokenRoot, { recursive: true, force: true });
    let activeShadow = brokenShadow;
    const cleanup = setupServerObservers(
      baseOpts({
        doc,
        xmlFragment,
        ytext,
        mdManager: losing,
        docName: 'retry.md',
        shadow: () => activeShadow,
        contentRoot: 'content',
        getBranch: () => 'main',
      }),
    );
    const failureLogged = async (tries = 120): Promise<boolean> => {
      for (let i = 0; i < tries; i++) {
        const hit = logWarn.mock.calls
          .map((call) => String(call[1]))
          .some((line) => line.includes('checkpoint write failed'));
        if (hit) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    };
    try {
      seedFragment(doc, xmlFragment, PLAIN_MD);
      const lastGood = ytext.toString();
      seedFragment(doc, xmlFragment, cellBody('keepA'));
      expect(await failureLogged()).toBe(true);
      activeShadow = shadow;
      restoreYtext({ doc, ytext }, lastGood);
      const retryClockBase = Date.now();
      const retryNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => retryClockBase + 2_001);
      try {
        seedFragment(doc, xmlFragment, cellBody('keepB'));
      } finally {
        retryNowSpy.mockRestore();
      }
      expect((await waitForCheckpointRefs(shadow)).length).toBeGreaterThanOrEqual(1);
    } finally {
      logWarn.mockRestore();
      warn.mockRestore();
      cleanup();
    }
  });
});

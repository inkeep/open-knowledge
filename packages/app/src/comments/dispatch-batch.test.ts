import { describe, expect, test, vi } from 'vitest';
import { composeCommentBatchInstruction } from './comment-chips';

vi.mock('./comments-client', () => {
  const metas = [
    {
      threadId: 't1',
      docName: 'recipes/one',
      anchor: { exact: 'Heat oven to 425F', prefix: '', suffix: '', start: 0, end: 17 },
      state: 'anchored',
      queued: true,
      latestComment: 'note on t1',
      createdBy: 'principal-abc',
      createdAt: 800,
    },
    {
      threadId: 't2',
      docName: 'recipes/two',
      anchor: { exact: 'Whisk the peanut sauce', prefix: '', suffix: '', start: 0, end: 22 },
      state: 'anchored',
      queued: true,
      latestComment: 'note on t2',
      createdBy: 'principal-abc',
      createdAt: 900,
    },
    {
      threadId: 't3',
      docName: 'recipes/three',
      anchor: { exact: 'cooked brown rice', prefix: '', suffix: '', start: 0, end: 17 },
      state: 'anchored',
      queued: true,
      latestComment: 'note on t3',
      createdBy: 'principal-abc',
      createdAt: 1000,
    },
  ];
  return {
    __metas: metas,
    listThreads: vi.fn(async () => metas),
    createThread: vi.fn(),
    reply: vi.fn(),
    reopenThread: vi.fn(),
    replaceAnchor: vi.fn(),
    queueThread: vi.fn(),
    unqueueThread: vi.fn(),
    deleteThread: vi.fn(),
    prepareDispatchBatch: vi.fn(async (ids: readonly string[]) => ({
      results: ids.map((id) => {
        const m = metas.find((entry) => entry.threadId === id);
        if (!m) return { threadId: id, ok: false, error: 'not-found' };
        return {
          threadId: id,
          ok: true,
          meta: m,
          payload: {
            docName: m.docName,
            instruction: `note on ${id}`,
            passage: { exact: m.anchor.exact, prefix: '', suffix: '' },
            anchorLost: false,
          },
        };
      }),
    })),
    completeDispatchBatch: vi.fn(async (ids: readonly string[]) => ({
      results: ids.map((id) => ({ threadId: id, ok: true, meta: metas[0] })),
    })),
  };
});

function dispatchWith(
  store: typeof import('./store'),
  compose: (items: readonly { threadId: string; payload: unknown }[]) => Promise<boolean>,
): Promise<string[]> {
  // biome-ignore lint/suspicious/noExplicitAny: structural payload in a test double
  return store.dispatchComments({ compose: compose as any });
}

describe('dispatchComments', () => {
  test('hands the composer every selected comment, not just the first', async () => {
    vi.resetModules();
    const store = await import('./store');
    await store.refresh();

    expect(store.getSelectedQueue()).toHaveLength(3);

    const seen: number[] = [];
    const shipped = await dispatchWith(store, async (items) => {
      seen.push(items.length);
      return true;
    });

    expect(seen).toEqual([3]);
    expect(shipped).toHaveLength(3);
    const api = await import('./comments-client');
    expect(api.completeDispatchBatch).toHaveBeenCalledWith(['t1', 't2', 't3']);
  });

  test('the batch ships in the order the comments were written', async () => {
    vi.resetModules();
    const store = await import('./store');
    await store.refresh();

    expect(store.getQueue()).toEqual(['t1', 't2', 't3']);

    const order: string[] = [];
    await dispatchWith(store, async (items) => {
      order.push(...items.map((item) => item.payload.docName));
      return true;
    });
    expect(order).toEqual(['recipes/one', 'recipes/two', 'recipes/three']);
  });

  test('a deselected comment is excluded but the rest still ship', async () => {
    vi.resetModules();
    const store = await import('./store');
    await store.refresh();
    store.toggleQueueSelection('t2');

    const shipped = await dispatchWith(store, async () => true);
    expect(shipped).toEqual(['t1', 't3']);
  });

  test('a second send while one is in flight is dropped, not duplicated', async () => {
    vi.resetModules();
    const store = await import('./store');
    await store.refresh();

    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const composed: number[] = [];

    const first = dispatchWith(store, async (items) => {
      composed.push(items.length);
      await held;
      return true;
    });
    await vi.waitFor(() => expect(composed).toHaveLength(1));
    const second = await dispatchWith(store, async (items) => {
      composed.push(items.length);
      return true;
    });

    expect(second).toEqual([]);
    release();
    expect(await first).toEqual(['t1', 't2', 't3']);
    expect(composed).toEqual([3]);
  });

  test('a send is possible again once the in-flight one finishes', async () => {
    vi.resetModules();
    const store = await import('./store');
    await store.refresh();

    expect(await dispatchWith(store, async () => false)).toEqual([]);
    expect(await dispatchWith(store, async () => true)).toEqual(['t1', 't2', 't3']);
  });

  test('the Queue panel Send delivers ONE turn carrying every comment', async () => {
    vi.resetModules();
    const store = await import('./store');
    await store.refresh();

    const calls: number[] = [];
    await dispatchWith(store, async (items) => {
      calls.push(items.length);
      return true;
    });

    expect(calls).toEqual([3]);
    const api = await import('./comments-client');
    expect(api.completeDispatchBatch).toHaveBeenCalledWith(['t1', 't2', 't3']);
  });

  test('a hand-off that only stages can decline to resolve', async () => {
    vi.resetModules();
    const store = await import('./store');
    await store.refresh();
    vi.clearAllMocks();

    const shipped = await store.dispatchComments({
      compose: async () => true,
      resolve: false,
    });

    expect(shipped).toEqual(['t1', 't2', 't3']);
    const api = await import('./comments-client');
    expect(api.completeDispatchBatch).not.toHaveBeenCalled();
  });

  test('deselecting drops the selected count the chip shows', async () => {
    vi.resetModules();
    const store = await import('./store');
    await store.refresh();
    expect(store.getSelectedQueue()).toHaveLength(3);

    store.toggleQueueSelection('t2');
    expect(store.getSelectedQueue()).toHaveLength(2);
    expect(store.getQueue()).toHaveLength(3);

    store.toggleQueueSelection('t2');
    expect(store.getSelectedQueue()).toHaveLength(3);
  });

  test('a failed hand-off ships nothing and leaves everything queued', async () => {
    vi.resetModules();
    const store = await import('./store');
    await store.refresh();

    const shipped = await dispatchWith(store, async () => false);
    expect(shipped).toEqual([]);
  });
});

describe('composeCommentBatchInstruction', () => {
  test('names every comment with its own document and passage', () => {
    const prompt = composeCommentBatchInstruction(
      [
        { docName: 'recipes/one', body: 'how hot?', quote: 'Heat oven to 425F', anchorLost: false },
        { docName: 'recipes/two', body: 'parmesan?', quote: 'Whisk the sauce', anchorLost: false },
        { docName: 'recipes/three', body: 'swap rice?', quote: 'brown rice', anchorLost: false },
      ],
      'Work through these',
    );

    expect(prompt).toContain('Work through these');
    expect(prompt).toContain('The 3 comments:');
    for (const fragment of [
      'recipes/one',
      'how hot?',
      'Heat oven to 425F',
      'recipes/two',
      'parmesan?',
      'recipes/three',
      'swap rice?',
      'brown rice',
    ]) {
      expect(prompt).toContain(fragment);
    }
  });
});

describe('composeCommentBatchInstruction — the pinned passage', () => {
  const items = [
    { docName: 'recipes/one', body: 'how hot?', quote: 'Heat oven to 425F', anchorLost: false },
  ];

  test('carries a selection that belongs to no comment', () => {
    const prompt = composeCommentBatchInstruction(items, 'Work through these', {
      docName: 'recipes/one',
      markdown: '- 2 tbsp neutral oil',
    });

    expect(prompt).toContain('2 tbsp neutral oil');
    expect(prompt).toContain('not a comment');
    expect(prompt.indexOf('The comment:')).toBeLessThan(prompt.indexOf('2 tbsp neutral oil'));
  });

  test('adds nothing when no passage is pinned', () => {
    const prompt = composeCommentBatchInstruction(items, 'Work through these');
    expect(prompt).not.toContain('not a comment');
  });

  test('an empty pinned passage is not announced', () => {
    const prompt = composeCommentBatchInstruction(items, '', {
      docName: 'recipes/one',
      markdown: '   \n  ',
    });
    expect(prompt).not.toContain('not a comment');
  });
});

describe('composeCommentBatchInstruction — a quote that repeats', () => {
  const base = {
    docName: 'recipes/one',
    body: 'tighten this',
    quote: 'needs space',
    anchorLost: false,
    prefix: '…1 tsp honey or maple, ',
    suffix: ' around the header. Outro.',
  };

  test('says which occurrence is meant', () => {
    const prompt = composeCommentBatchInstruction([{ ...base, repeats: true }], '');
    expect(prompt).toContain('appears more than once');
    expect(prompt).toContain('1 tsp honey or maple');
    expect(prompt).toContain('around the header');
    expect(prompt).toContain('rather than the first occurrence');
  });

  test('stays terse when the quote is unique', () => {
    const prompt = composeCommentBatchInstruction([{ ...base, repeats: false }], '');
    expect(prompt).not.toContain('appears more than once');
    expect(prompt).toContain('needs space');
  });

  test('a passage at the start of the file is described by what follows it', () => {
    const prompt = composeCommentBatchInstruction([{ ...base, repeats: true, prefix: '' }], '');
    expect(prompt).toContain('at the start of the file');
  });

  test('a passage at the end of the file is described by what precedes it', () => {
    const prompt = composeCommentBatchInstruction([{ ...base, repeats: true, suffix: '' }], '');
    expect(prompt).toContain('at the end of the file');
  });

  test('long context is trimmed rather than dumped whole', () => {
    const prompt = composeCommentBatchInstruction(
      [{ ...base, repeats: true, prefix: 'x'.repeat(400), suffix: 'y'.repeat(400) }],
      '',
    );
    expect(prompt).not.toContain('x'.repeat(200));
    expect(prompt).toContain('…');
  });

  test('no context at all falls back to no note rather than an empty one', () => {
    const prompt = composeCommentBatchInstruction(
      [{ ...base, repeats: true, prefix: '', suffix: '' }],
      '',
    );
    expect(prompt).not.toContain('appears more than once');
  });
});

describe('the composed instruction for a property comment', () => {
  const propertyItem = {
    docName: 'recipes/one',
    body: 'this should be the publish date, not the created date',
    propertyKey: 'date',
    quote: '',
    anchorLost: false,
    prefix: '',
    suffix: '',
    repeats: false,
  };

  test('names the key instead of quoting a passage', () => {
    const out = composeCommentBatchInstruction([propertyItem], '');
    expect(out).toContain('on the `date` property (frontmatter)');
    expect(out).toContain('this should be the publish date');
    expect(out).not.toContain('>');
  });

  test('a removed key is called out as lost, naming the key', () => {
    const out = composeCommentBatchInstruction([{ ...propertyItem, anchorLost: true }], '');
    expect(out).toContain('`date` is no longer in this document');
    expect(out).not.toContain('this passage is no longer in the document');
  });

  test('property and passage comments compose into one numbered batch', () => {
    const passageItem = {
      docName: 'recipes/two',
      body: 'stale example',
      propertyKey: null,
      quote: 'Whisk the peanut sauce',
      anchorLost: false,
      prefix: '',
      suffix: '',
      repeats: false,
    };
    const out = composeCommentBatchInstruction([propertyItem, passageItem], 'Fix these');
    expect(out).toContain('The 2 comments:');
    expect(out).toContain('1. In `recipes/one`, on the `date` property');
    expect(out).toContain('2. In `recipes/two`, on this passage:');
    expect(out).toContain('   > Whisk the peanut sauce');
  });
});

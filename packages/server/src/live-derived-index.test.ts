import { setTimeout as wait } from 'node:timers/promises';
import { Hocuspocus } from '@hocuspocus/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import type { DerivedDocumentIndexLivePort } from './derived-document-index.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import { applyExternalChange } from './external-change.ts';
import { createLiveDerivedIndexExtension } from './live-derived-index.ts';
import { getLogger } from './logger.ts';

type Conn = Awaited<ReturnType<Hocuspocus['openDirectConnection']>>;

function getDoc(conn: Conn): Y.Doc {
  const doc = (conn as unknown as { document: Y.Doc }).document;
  if (!doc) throw new Error('DirectConnection has no document');
  return doc;
}

function makeOnChangePayload(
  hp: Hocuspocus,
  document: Y.Doc,
  documentName: string,
  transactionOrigin: unknown,
) {
  return {
    clientsCount: 0,
    connection: undefined,
    context: {},
    document,
    documentName,
    instance: hp,
    requestHeaders: new Headers(),
    requestParameters: new URLSearchParams(),
    socketId: '',
    transactionOrigin,
    update: new Uint8Array(),
  };
}

function createDerivedIndexPort(
  recordLiveDocument = vi.fn(async (_documentName: string, _markdown: string) => {}),
  captureLiveUpdateToken = vi.fn((): number | null => 0),
): DerivedDocumentIndexLivePort {
  return { captureLiveUpdateToken, recordLiveDocument };
}

describe('createLiveDerivedIndexExtension', () => {
  let hp: Hocuspocus;
  let durabilityState: DocumentDurabilityState;

  beforeEach(() => {
    hp = new Hocuspocus({ quiet: true });
    durabilityState = new DocumentDurabilityState();
  });

  test('skips file-watcher origin transactions', async () => {
    const recordLiveDocument = vi.fn(async () => {});
    const extension = createLiveDerivedIndexExtension({
      derivedDocumentIndex: createDerivedIndexPort(recordLiveDocument),
      debounceMs: 5,
    });
    const conn = await hp.openDirectConnection('skip-file-watcher');
    const doc = getDoc(conn);

    applyExternalChange(durabilityState, hp, 'skip-file-watcher', '# Hello\n\n[[beta]]\n');
    await extension.onChange?.(
      makeOnChangePayload(hp, doc, 'skip-file-watcher', {
        source: 'local',
        context: { origin: 'file-watcher' },
      }),
    );
    await wait(20);

    expect(recordLiveDocument).not.toHaveBeenCalled();
    await conn.disconnect();
  });

  test('drops live changes while the coordinator withholds a branch token', async () => {
    const recordLiveDocument = vi.fn(async () => {});
    const extension = createLiveDerivedIndexExtension({
      derivedDocumentIndex: createDerivedIndexPort(
        recordLiveDocument,
        vi.fn(() => null),
      ),
      debounceMs: 5,
    });
    const conn = await hp.openDirectConnection('branch-transition');
    const doc = getDoc(conn);

    applyExternalChange(durabilityState, hp, 'branch-transition', '# Old branch\n');
    await extension.onChange?.(
      makeOnChangePayload(hp, doc, 'branch-transition', {
        source: 'local',
        context: { origin: 'branch-switch' },
      }),
    );
    await wait(20);

    expect(recordLiveDocument).not.toHaveBeenCalled();
    await conn.disconnect();
  });

  test('debounces rapid changes to a single update and preserves frontmatter', async () => {
    const recordLiveDocument = vi.fn(async () => {});
    const extension = createLiveDerivedIndexExtension({
      derivedDocumentIndex: createDerivedIndexPort(recordLiveDocument),
      debounceMs: 5,
    });
    const conn = await hp.openDirectConnection('debounced-doc');
    const doc = getDoc(conn);

    applyExternalChange(
      durabilityState,
      hp,
      'debounced-doc',
      '---\ntitle: Debounced\n---\n# Hello\n\n[[beta]]\n',
    );
    const payload = makeOnChangePayload(hp, doc, 'debounced-doc', {
      source: 'local',
      context: { origin: 'agent-write' },
    });

    await extension.onChange?.(payload);
    await extension.onChange?.(payload);
    await extension.onChange?.(payload);
    await wait(20);

    expect(recordLiveDocument).toHaveBeenCalledTimes(1);
    expect(recordLiveDocument).toHaveBeenCalledWith(
      'debounced-doc',
      '---\ntitle: Debounced\n---\n# Hello\n\n[[beta]]\n',
      0,
    );
    await conn.disconnect();
  });

  test('hands one settled raw markdown string to the derived-index boundary', async () => {
    const recordLiveDocument = vi.fn(async () => {});
    const extension = createLiveDerivedIndexExtension({
      derivedDocumentIndex: createDerivedIndexPort(recordLiveDocument),
      debounceMs: 5,
    });
    const conn = await hp.openDirectConnection('tag-derived-doc');
    const doc = getDoc(conn);

    applyExternalChange(durabilityState, hp, 'tag-derived-doc', '# Hello\n\nA #typescript note.\n');
    const payload = makeOnChangePayload(hp, doc, 'tag-derived-doc', {
      source: 'local',
      context: { origin: 'agent-write' },
    });

    await extension.onChange?.(payload);
    await wait(20);

    expect(recordLiveDocument).toHaveBeenCalledExactlyOnceWith(
      'tag-derived-doc',
      '# Hello\n\nA #typescript note.\n',
      0,
    );
    await conn.disconnect();
  });

  test('beforeUnloadDocument flushes the pending update instead of dropping it', async () => {
    const recordLiveDocument = vi.fn(async () => {});
    const extension = createLiveDerivedIndexExtension({
      derivedDocumentIndex: createDerivedIndexPort(recordLiveDocument),
      debounceMs: 20,
    });
    const conn = await hp.openDirectConnection('unload-doc');
    const doc = getDoc(conn);

    applyExternalChange(durabilityState, hp, 'unload-doc', '# Hello\n');
    await extension.onChange?.(
      makeOnChangePayload(hp, doc, 'unload-doc', {
        source: 'local',
        context: { origin: 'agent-write' },
      }),
    );
    await extension.beforeUnloadDocument?.({
      document: doc,
      documentName: 'unload-doc',
      instance: hp,
    });
    expect(recordLiveDocument).toHaveBeenCalledTimes(1);
    expect(recordLiveDocument.mock.calls[0]?.[1]).toContain('# Hello');

    await wait(40);
    expect(recordLiveDocument).toHaveBeenCalledTimes(1);
    await conn.disconnect();
  });

  test('onDestroy clears pending timers across documents', async () => {
    const recordLiveDocument = vi.fn(async () => {});
    const extension = createLiveDerivedIndexExtension({
      derivedDocumentIndex: createDerivedIndexPort(recordLiveDocument),
      debounceMs: 20,
    });
    const first = await hp.openDirectConnection('destroy-a');
    const second = await hp.openDirectConnection('destroy-b');
    const firstDoc = getDoc(first);
    const secondDoc = getDoc(second);

    applyExternalChange(durabilityState, hp, 'destroy-a', '# A\n');
    applyExternalChange(durabilityState, hp, 'destroy-b', '# B\n');
    await extension.onChange?.(
      makeOnChangePayload(hp, firstDoc, 'destroy-a', {
        source: 'local',
        context: { origin: 'agent-write' },
      }),
    );
    await extension.onChange?.(
      makeOnChangePayload(hp, secondDoc, 'destroy-b', {
        source: 'local',
        context: { origin: 'agent-write' },
      }),
    );
    await extension.onDestroy?.({
      instance: hp,
      configuration: hp.configuration,
      version: '',
    });
    await wait(40);

    expect(recordLiveDocument).not.toHaveBeenCalled();
    await first.disconnect();
    await second.disconnect();
  });

  test('FR-43: backlink update receives raw ytext bytes (CRLF survives)', async () => {
    const recordLiveDocument = vi.fn(async () => {});
    const extension = createLiveDerivedIndexExtension({
      derivedDocumentIndex: createDerivedIndexPort(recordLiveDocument),
      debounceMs: 5,
    });
    const conn = await hp.openDirectConnection('crlf-doc');
    const doc = getDoc(conn);

    applyExternalChange(durabilityState, hp, 'crlf-doc', '# Title\r\n\r\nLine A\r\nLine B\r\n');
    await extension.onChange?.(
      makeOnChangePayload(hp, doc, 'crlf-doc', {
        source: 'local',
        context: { origin: 'agent-write' },
      }),
    );
    await wait(20);

    expect(recordLiveDocument).toHaveBeenCalledTimes(1);
    const [, bodyArg] = recordLiveDocument.mock.calls[0] as [string, string];
    expect(bodyArg).toContain('\r\n');
    expect(bodyArg).toBe('# Title\r\n\r\nLine A\r\nLine B\r\n');
    await conn.disconnect();
  });

  test('FR-43: doc-start `---\\n` survives (architectural-floor case)', async () => {
    const recordLiveDocument = vi.fn(async () => {});
    const extension = createLiveDerivedIndexExtension({
      derivedDocumentIndex: createDerivedIndexPort(recordLiveDocument),
      debounceMs: 5,
    });
    const conn = await hp.openDirectConnection('thematic-doc');
    const doc = getDoc(conn);

    applyExternalChange(durabilityState, hp, 'thematic-doc', '---\n# Title\n');
    await extension.onChange?.(
      makeOnChangePayload(hp, doc, 'thematic-doc', {
        source: 'local',
        context: { origin: 'agent-write' },
      }),
    );
    await wait(20);

    expect(recordLiveDocument).toHaveBeenCalledTimes(1);
    const [, bodyArg] = recordLiveDocument.mock.calls[0] as [string, string];
    expect(bodyArg).toBe('---\n# Title\n');
    expect(bodyArg).not.toContain('***');
    await conn.disconnect();
  });

  test('FR-43: angle-bracket autolink form is observable in backlink snippet', async () => {
    const recordLiveDocument = vi.fn(async () => {});
    const extension = createLiveDerivedIndexExtension({
      derivedDocumentIndex: createDerivedIndexPort(recordLiveDocument),
      debounceMs: 5,
    });
    const conn = await hp.openDirectConnection('autolink-doc');
    const doc = getDoc(conn);

    applyExternalChange(
      durabilityState,
      hp,
      'autolink-doc',
      '# Page\n\nVisit <https://example.com> for info\n',
    );
    await extension.onChange?.(
      makeOnChangePayload(hp, doc, 'autolink-doc', {
        source: 'local',
        context: { origin: 'agent-write' },
      }),
    );
    await wait(20);

    expect(recordLiveDocument).toHaveBeenCalledTimes(1);
    const [, bodyArg] = recordLiveDocument.mock.calls[0] as [string, string];
    expect(bodyArg).toContain('<https://example.com>');
    expect(bodyArg).not.toContain('[https://example.com](https://example.com)');
    await conn.disconnect();
  });

  test('logs and swallows callback errors', async () => {
    const recordLiveDocument = vi.fn(async () => {
      throw new Error('boom');
    });
    const extension = createLiveDerivedIndexExtension({
      derivedDocumentIndex: createDerivedIndexPort(recordLiveDocument),
      debounceMs: 5,
    });
    const conn = await hp.openDirectConnection('error-doc');
    const doc = getDoc(conn);
    const errorSpy = vi.spyOn(getLogger('live-derived-index'), 'error');

    try {
      applyExternalChange(durabilityState, hp, 'error-doc', '# Error\n');
      await extension.onChange?.(
        makeOnChangePayload(hp, doc, 'error-doc', {
          source: 'local',
          context: { origin: 'agent-write' },
        }),
      );
      await wait(20);

      expect(recordLiveDocument).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalled();
      expect(String(errorSpy.mock.calls[0]?.[1])).toContain(
        'Failed to update derived views for error-doc',
      );
    } finally {
      errorSpy.mockRestore();
      await conn.disconnect();
    }
  });
});

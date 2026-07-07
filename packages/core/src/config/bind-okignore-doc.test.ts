import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { bindOkignoreDoc, type OkignoreDocProvider } from './bind-okignore-doc.ts';
import { isKnownConfigError } from './errors.ts';

/**
 * Minimal `OkignoreDocProvider` for tests — the structural shape
 * `bindOkignoreDoc` needs (`document` + `on('synced')` + `off('synced')`).
 * Keeps tests free of a runtime `@hocuspocus/provider` dep.
 */
function createMockProvider(doc: Y.Doc): OkignoreDocProvider & {
  emitSynced(): void;
  syncedListenerCount(): number;
} {
  const syncedListeners = new Set<() => void>();
  return {
    document: doc,
    on(event, listener) {
      if (event === 'synced') syncedListeners.add(listener);
    },
    off(event, listener) {
      if (event === 'synced') syncedListeners.delete(listener);
    },
    emitSynced() {
      for (const listener of syncedListeners) listener();
    },
    syncedListenerCount() {
      return syncedListeners.size;
    },
  };
}

let doc: Y.Doc;
let provider: ReturnType<typeof createMockProvider>;

beforeEach(() => {
  doc = new Y.Doc();
  provider = createMockProvider(doc);
});

afterEach(() => {
  doc.destroy();
});

describe('bindOkignoreDoc — current()', () => {
  test('empty Y.Text returns empty string', () => {
    const binding = bindOkignoreDoc(provider);
    expect(binding.current()).toBe('');
    binding.dispose();
  });

  test('existing Y.Text content returned verbatim', () => {
    doc.getText('source').insert(0, 'drafts/\n*.draft.md\n');
    const binding = bindOkignoreDoc(provider);
    expect(binding.current()).toBe('drafts/\n*.draft.md\n');
    binding.dispose();
  });

  test('comments and blank lines preserved verbatim (no normalisation)', () => {
    const raw = '# header\n\ndrafts/\n\n# another\n*.tmp\n';
    doc.getText('source').insert(0, raw);
    const binding = bindOkignoreDoc(provider);
    expect(binding.current()).toBe(raw);
    binding.dispose();
  });

  test('unparseable gitignore patterns returned verbatim (no schema validation)', () => {
    // npm:ignore does not throw on these — they are simply tolerated as
    // user-data bytes. The binding should not pre-process them.
    const raw = '[unmatched\nlone-!\nsomething\\\n  leading-space\n';
    doc.getText('source').insert(0, raw);
    const binding = bindOkignoreDoc(provider);
    expect(binding.current()).toBe(raw);
    binding.dispose();
  });

  test('honors custom ytextKey override (test isolation)', () => {
    doc.getText('alt').insert(0, 'drafts/\n');
    const binding = bindOkignoreDoc(provider, { ytextKey: 'alt' });
    expect(binding.current()).toBe('drafts/\n');
    binding.dispose();
  });
});

describe('bindOkignoreDoc — patch()', () => {
  test('writes text to empty Y.Text + returns Result.ok with the same text', () => {
    const binding = bindOkignoreDoc(provider);
    const result = binding.patch('drafts/\n');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.text).toBe('drafts/\n');
    expect(doc.getText('source').toString()).toBe('drafts/\n');
    binding.dispose();
  });

  test('overwrites existing Y.Text content', () => {
    doc.getText('source').insert(0, 'old/\n');
    const binding = bindOkignoreDoc(provider);
    const result = binding.patch('new/\n');
    expect(result.ok).toBe(true);
    expect(doc.getText('source').toString()).toBe('new/\n');
    binding.dispose();
  });

  test('empty string clears Y.Text', () => {
    doc.getText('source').insert(0, 'old/\n');
    const binding = bindOkignoreDoc(provider);
    const result = binding.patch('');
    expect(result.ok).toBe(true);
    expect(doc.getText('source').toString()).toBe('');
    binding.dispose();
  });

  test('preserves comments and blank lines through round-trip', () => {
    const raw = '# header\n\ndrafts/\n\n# another\n*.tmp\n';
    const binding = bindOkignoreDoc(provider);
    binding.patch(raw);
    // Re-read via current() — must be byte-identical.
    expect(binding.current()).toBe(raw);
    binding.dispose();
  });

  test('after dispose, patch returns WRITE_ERROR', () => {
    const binding = bindOkignoreDoc(provider);
    binding.dispose();

    const result = binding.patch('drafts/\n');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    if (!isKnownConfigError(result.error)) throw new Error('not known error');
    expect(result.error.code).toBe('WRITE_ERROR');
  });

  test('does not perform any client-side syntax validation', () => {
    // The L1 contract for okignore is text-only: every non-disposed patch
    // returns Result.ok. The server's L3 is the rejection authority.
    const binding = bindOkignoreDoc(provider);
    const trickyInputs = [
      ' ',
      '\t',
      '!',
      '[unmatched',
      'trailing\\\n',
      '\r\nline\r\n',
      ' leading-whitespace',
      '\n\n\n',
    ];
    for (const input of trickyInputs) {
      expect(binding.patch(input).ok).toBe(true);
    }
    binding.dispose();
  });
});

describe('bindOkignoreDoc — subscribe()', () => {
  test('listener fires on Y.Text change after subscribe', () => {
    const binding = bindOkignoreDoc(provider);
    const received: string[] = [];

    const unsub = binding.subscribe((text) => {
      received.push(text);
    });

    binding.patch('a/\n');
    expect(received).toEqual(['a/\n']);

    binding.patch('a/\nb/\n');
    expect(received).toEqual(['a/\n', 'a/\nb/\n']);

    unsub();
    binding.patch('c/\n');
    expect(received).toEqual(['a/\n', 'a/\nb/\n']); // unchanged after unsub
    binding.dispose();
  });

  test('listener does NOT fire synchronously on subscribe', () => {
    doc.getText('source').insert(0, 'drafts/\n');
    const binding = bindOkignoreDoc(provider);
    const received: string[] = [];

    binding.subscribe((text) => {
      received.push(text);
    });

    expect(received).toEqual([]); // not fired yet
    binding.dispose();
  });

  test('listener fires on provider synced event (reconnect-fresh-value)', () => {
    doc.getText('source').insert(0, 'drafts/\n');
    const binding = bindOkignoreDoc(provider);
    const received: string[] = [];
    binding.subscribe((text) => {
      received.push(text);
    });

    // Simulate provider reconnect — content unchanged but synced fires.
    provider.emitSynced();

    expect(received).toEqual(['drafts/\n']);
    binding.dispose();
  });

  test('listener exception is caught — does not break other listeners', () => {
    const binding = bindOkignoreDoc(provider);
    const ok: string[] = [];

    binding.subscribe(() => {
      throw new Error('boom');
    });
    binding.subscribe((text) => {
      ok.push(text);
    });

    binding.patch('drafts/\n');
    expect(ok).toEqual(['drafts/\n']);
    binding.dispose();
  });

  test('multiple subscribers fire in registration order', () => {
    const binding = bindOkignoreDoc(provider);
    const order: number[] = [];

    binding.subscribe(() => order.push(1));
    binding.subscribe(() => order.push(2));
    binding.subscribe(() => order.push(3));

    binding.patch('drafts/\n');
    expect(order).toEqual([1, 2, 3]);
    binding.dispose();
  });

  test('external Y.Text replacement (server-origin path) fires subscribers', () => {
    // Simulates applyExternalConfigChange / file-watcher path: server-origin
    // Y.Text replacement caused by an external CLI / hand-edit / MCP-from-
    // other-session write. The binding's Y.Text observer must fire for the
    // resulting update.
    const binding = bindOkignoreDoc(provider);
    const received: string[] = [];
    binding.subscribe((text) => {
      received.push(text);
    });

    const ytext = doc.getText('source');
    doc.transact(() => {
      ytext.insert(0, 'logs/\n');
    });

    expect(received).toEqual(['logs/\n']);
    binding.dispose();
  });
});

describe('bindOkignoreDoc — status() + subscribeStatus()', () => {
  test('initial status is idle before any patch', () => {
    const binding = bindOkignoreDoc(provider);
    expect(binding.status()).toBe('idle');
    binding.dispose();
  });

  test('patch flips status to pending; acceptance timer flips to accepted', async () => {
    const binding = bindOkignoreDoc(provider, { acceptanceDelayMs: 10 });
    binding.patch('drafts/\n');
    expect(binding.status()).toBe('pending');
    await new Promise((r) => setTimeout(r, 30));
    expect(binding.status()).toBe('accepted');
    binding.dispose();
  });

  test('subscribeStatus fires on every transition', async () => {
    const binding = bindOkignoreDoc(provider, { acceptanceDelayMs: 10 });
    const seen: string[] = [];
    binding.subscribeStatus((s) => {
      seen.push(s);
    });

    binding.patch('drafts/\n');
    await new Promise((r) => setTimeout(r, 30));
    binding.notifyRejection({ code: 'OKIGNORE_INVALID', detail: 'whitespace-only line' });

    expect(seen).toEqual(['pending', 'accepted', 'rejected']);
    binding.dispose();
  });

  test('subscribeStatus does NOT fire synchronously on subscribe', () => {
    const binding = bindOkignoreDoc(provider, { acceptanceDelayMs: 10 });
    const seen: string[] = [];
    binding.subscribeStatus((s) => {
      seen.push(s);
    });
    expect(seen).toEqual([]);
    binding.dispose();
  });

  test('notifyRejection cancels the pending acceptance timer', async () => {
    const binding = bindOkignoreDoc(provider, { acceptanceDelayMs: 50 });
    binding.patch('drafts/\n');
    expect(binding.status()).toBe('pending');
    binding.notifyRejection({ code: 'OKIGNORE_INVALID', detail: 'whitespace-only line' });
    expect(binding.status()).toBe('rejected');
    // Wait past the acceptance window — status must NOT flip back to accepted.
    await new Promise((r) => setTimeout(r, 80));
    expect(binding.status()).toBe('rejected');
    binding.dispose();
  });

  test('subsequent patch after rejection resets status to pending', () => {
    const binding = bindOkignoreDoc(provider, { acceptanceDelayMs: 50 });
    binding.patch('drafts/\n');
    binding.notifyRejection({ code: 'OKIGNORE_INVALID', detail: 'bad line' });
    expect(binding.status()).toBe('rejected');

    binding.patch('repairs/\n');
    expect(binding.status()).toBe('pending');
    binding.dispose();
  });

  test('subscribeStatus listener exception is caught', () => {
    const binding = bindOkignoreDoc(provider, { acceptanceDelayMs: 10 });
    const ok: string[] = [];
    binding.subscribeStatus(() => {
      throw new Error('boom');
    });
    binding.subscribeStatus((s) => {
      ok.push(s);
    });
    binding.patch('drafts/\n');
    expect(ok).toEqual(['pending']);
    binding.dispose();
  });

  test('repeated identical status transitions do NOT re-fire listeners', () => {
    const binding = bindOkignoreDoc(provider);
    const seen: string[] = [];
    binding.subscribeStatus((s) => {
      seen.push(s);
    });

    binding.notifyRejection({ code: 'OKIGNORE_INVALID', detail: 'bad' });
    binding.notifyRejection({ code: 'OKIGNORE_INVALID', detail: 'bad again' });

    // Two notifyRejection calls; status was 'idle' → 'rejected' on the
    // first, then stayed 'rejected' on the second. setStatus short-
    // circuits identical transitions, so subscribers see one transition.
    expect(seen).toEqual(['rejected']);
    binding.dispose();
  });
});

describe('bindOkignoreDoc — subscribeRejection() + notifyRejection()', () => {
  test('subscribeRejection fires when notifyRejection is called', () => {
    doc.getText('source').insert(0, 'drafts/\n');
    const binding = bindOkignoreDoc(provider);
    const captured: Array<{ code: string; text: string }> = [];

    binding.subscribeRejection((rej) => {
      captured.push({ code: rej.error.code, text: rej.text });
    });

    binding.notifyRejection({
      code: 'OKIGNORE_INVALID',
      detail: 'whitespace-only line',
      lineNumber: 2,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.code).toBe('OKIGNORE_INVALID');
    expect(captured[0]?.text).toBe('drafts/\n');
    binding.dispose();
  });

  test('rejection event carries the post-revert text (current Y.Text snapshot)', () => {
    // Simulate the sequence: patch lands optimistically; server-side L3
    // revert mutates Y.Text back to LKG; CC1 broadcast arrives → consumer
    // calls notifyRejection. By the time notifyRejection runs, Y.Text
    // is already the LKG content (revert lands on the wire BEFORE the CC1
    // broadcast).
    doc.getText('source').insert(0, 'lkg/\n');
    const binding = bindOkignoreDoc(provider);

    binding.patch('   \n'); // optimistic — would-be-rejected
    // Simulate the server-side revert: external mutation back to LKG.
    const ytext = doc.getText('source');
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, 'lkg/\n');
    });

    const captured: string[] = [];
    binding.subscribeRejection((rej) => {
      captured.push(rej.text);
    });

    binding.notifyRejection({ code: 'OKIGNORE_INVALID', detail: 'whitespace-only line' });
    expect(captured).toEqual(['lkg/\n']);
    binding.dispose();
  });

  test('subscribeRejection unsubscribe stops further deliveries', () => {
    const binding = bindOkignoreDoc(provider);
    const captured: string[] = [];

    const unsub = binding.subscribeRejection((rej) => {
      captured.push(rej.error.code);
    });

    binding.notifyRejection({ code: 'OKIGNORE_INVALID', detail: 'first' });
    unsub();
    binding.notifyRejection({ code: 'OKIGNORE_INVALID', detail: 'second' });

    expect(captured).toEqual(['OKIGNORE_INVALID']);
    binding.dispose();
  });

  test('rejection listener exception is caught — does not break other listeners', () => {
    const binding = bindOkignoreDoc(provider);
    const ok: string[] = [];

    binding.subscribeRejection(() => {
      throw new Error('boom');
    });
    binding.subscribeRejection((rej) => {
      ok.push(rej.error.code);
    });

    binding.notifyRejection({ code: 'OKIGNORE_INVALID', detail: 'bad' });
    expect(ok).toEqual(['OKIGNORE_INVALID']);
    binding.dispose();
  });

  test('notifyRejection on disposed binding is a silent no-op', () => {
    const binding = bindOkignoreDoc(provider);
    const captured: string[] = [];
    binding.subscribeRejection((rej) => {
      captured.push(rej.error.code);
    });
    binding.dispose();

    // Dispatcher could race the dispose — this MUST NOT throw.
    expect(() =>
      binding.notifyRejection({ code: 'OKIGNORE_INVALID', detail: 'late' }),
    ).not.toThrow();
    expect(captured).toEqual([]);
  });

  test('forward-compat error envelope (unknown code) is propagated verbatim', () => {
    // CC1 schema is `.loose()` so future server versions can emit codes the
    // client doesn't yet recognise. notifyRejection must not require a
    // KnownConfigValidationError narrowing — it accepts any
    // ConfigValidationError, including the forward-compat tail.
    const binding = bindOkignoreDoc(provider);
    const captured: Array<{ code: string }> = [];
    binding.subscribeRejection((rej) => {
      captured.push({ code: rej.error.code });
    });

    binding.notifyRejection({ code: 'FUTURE_CODE_NOT_YET_KNOWN', message: 'tbd' });
    expect(captured).toEqual([{ code: 'FUTURE_CODE_NOT_YET_KNOWN' }]);
    binding.dispose();
  });
});

describe('bindOkignoreDoc — dispose()', () => {
  test('clears Y.Text observer + provider listener + listener sets', () => {
    const binding = bindOkignoreDoc(provider);
    binding.subscribe(() => {});
    binding.subscribeRejection(() => {});
    binding.subscribeStatus(() => {});

    expect(provider.syncedListenerCount()).toBe(1);
    binding.dispose();
    expect(provider.syncedListenerCount()).toBe(0);

    // Subsequent Y.Text mutation does not leak listener invocations.
    let fired = false;
    binding.subscribe(() => {
      fired = true;
    });
    doc.getText('source').insert(0, 'drafts/\n');
    expect(fired).toBe(false);
  });

  test('idempotent — calling dispose twice is safe', () => {
    const binding = bindOkignoreDoc(provider);
    binding.dispose();
    expect(() => binding.dispose()).not.toThrow();
  });

  test('cancels in-flight acceptance timer on dispose', async () => {
    const binding = bindOkignoreDoc(provider, { acceptanceDelayMs: 50 });
    const seen: string[] = [];
    binding.subscribeStatus((s) => {
      seen.push(s);
    });
    binding.patch('drafts/\n');
    binding.dispose();
    // Wait past the acceptance window — listener MUST NOT fire post-dispose.
    await new Promise((r) => setTimeout(r, 80));
    // Only the 'pending' transition should appear (fired before dispose).
    expect(seen).toEqual(['pending']);
  });

  test('post-dispose patch returns WRITE_ERROR (no Y.Text mutation)', () => {
    const binding = bindOkignoreDoc(provider);
    doc.getText('source').insert(0, 'before/\n');
    binding.dispose();
    const before = doc.getText('source').toString();
    const result = binding.patch('after/\n');
    expect(result.ok).toBe(false);
    expect(doc.getText('source').toString()).toBe(before);
  });
});

describe('bindOkignoreDoc — multi-client / cross-process simulation', () => {
  test('two simultaneous Y.Text replacements via Yjs delta sync — both bindings converge', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const provA = createMockProvider(docA);
    const provB = createMockProvider(docB);

    docA.getText('source').insert(0, 'shared/\n');
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    const bindingA = bindOkignoreDoc(provA);
    const bindingB = bindOkignoreDoc(provB);

    bindingA.patch('shared/\nfromA/\n');
    bindingB.patch('shared/\nfromB/\n');

    // Cross-sync.
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

    // Both docs converge to the same Y.Text content.
    expect(docA.getText('source').toString()).toBe(docB.getText('source').toString());

    // Final state may be a CRDT-merged hybrid; current() must NOT throw and
    // must return a string.
    expect(typeof bindingA.current()).toBe('string');

    bindingA.dispose();
    bindingB.dispose();
    docA.destroy();
    docB.destroy();
  });
});

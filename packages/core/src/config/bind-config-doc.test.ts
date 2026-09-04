import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { bindConfigDoc, type ConfigDocProvider } from './bind-config-doc.ts';
import { isKnownConfigError } from './errors.ts';

function createMockProvider(doc: Y.Doc): ConfigDocProvider & {
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

describe('bindConfigDoc — current()', () => {
  test('empty Y.Text returns schema defaults', () => {
    const binding = bindConfigDoc(provider, 'project');
    const config = binding.current();
    expect(config.content).toBeDefined();
    expect(config.appearance).toBeDefined();
    expect(config.editor?.wordWrap).toBe(true);
    expect(config.editor?.previewTabs).toBe(true);
    binding.dispose();
  });

  test('valid YAML in Y.Text parses to merged Config', () => {
    const yaml = 'content:\n  dir: docs\n';
    doc.getText('source').insert(0, yaml);
    const binding = bindConfigDoc(provider, 'project');

    const config = binding.current();
    expect(config.content.dir).toBe('docs');
    binding.dispose();
  });

  test('invalid YAML falls back to defaults (never throws)', () => {
    doc.getText('source').insert(0, 'content:\n  dir: [unclosed');
    const binding = bindConfigDoc(provider, 'project');

    expect(() => binding.current()).not.toThrow();
    expect(binding.current().content.dir).toBe('.');
    binding.dispose();
  });

  test('schema-failing YAML falls back to defaults', () => {
    doc.getText('source').insert(0, 'appearance:\n  theme: 42\n');
    const binding = bindConfigDoc(provider, 'project');

    expect(() => binding.current()).not.toThrow();
    expect(binding.current().appearance?.theme).toBeUndefined();
    binding.dispose();
  });

  test('honors custom ytextKey override (test isolation)', () => {
    doc.getText('alt').insert(0, 'content:\n  dir: docs\n');
    const binding = bindConfigDoc(provider, 'project', { ytextKey: 'alt' });

    expect(binding.current().content.dir).toBe('docs');
    binding.dispose();
  });
});

describe('bindConfigDoc — patch()', () => {
  test('writes scalar to empty Y.Text + returns effective config', () => {
    const binding = bindConfigDoc(provider, 'user');
    const result = binding.patch({ appearance: { theme: 'dark' } });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.appliedPaths).toEqual(['appearance.theme']);
    expect(result.effective.appearance?.theme).toBe('dark');

    const ytext = doc.getText('source').toString();
    expect(ytext).toContain('appearance:');
    expect(ytext).toContain('theme: dark');
    binding.dispose();
  });

  test('writes editor.wordWrap to empty Y.Text + returns effective config', () => {
    const binding = bindConfigDoc(provider, 'user');
    const result = binding.patch({ editor: { wordWrap: false } });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.appliedPaths).toEqual(['editor.wordWrap']);
    expect(result.effective.editor?.wordWrap).toBe(false);

    const ytext = doc.getText('source').toString();
    expect(ytext).toContain('editor:');
    expect(ytext).toContain('wordWrap: false');
    binding.dispose();
  });

  test('writes editor.previewTabs to empty Y.Text + returns effective config', () => {
    const binding = bindConfigDoc(provider, 'user');
    const result = binding.patch({ editor: { previewTabs: false } });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.appliedPaths).toEqual(['editor.previewTabs']);
    expect(result.effective.editor?.previewTabs).toBe(false);

    const ytext = doc.getText('source').toString();
    expect(ytext).toContain('editor:');
    expect(ytext).toContain('previewTabs: false');
    binding.dispose();
  });

  test('writes the sidebar view toggles via a project-local binding + returns effective config', () => {
    const binding = bindConfigDoc(provider, 'project-local');
    const result = binding.patch({
      appearance: {
        sidebar: {
          showOnlyMarkdownFiles: true,
          showSkillsSection: false,
          showOkFolders: true,
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.appliedPaths).toEqual([
      'appearance.sidebar.showOnlyMarkdownFiles',
      'appearance.sidebar.showSkillsSection',
      'appearance.sidebar.showOkFolders',
    ]);
    expect(result.effective.appearance?.sidebar?.showOnlyMarkdownFiles).toBe(true);
    expect(result.effective.appearance?.sidebar?.showSkillsSection).toBe(false);
    expect(result.effective.appearance?.sidebar?.showOkFolders).toBe(true);
    binding.dispose();
  });

  test('updates existing field + preserves comments via yaml@2 Document', () => {
    const initial = '# Project config\ncontent:\n  dir: old # original\n';
    doc.getText('source').insert(0, initial);
    const binding = bindConfigDoc(provider, 'project');

    const result = binding.patch({ content: { dir: 'new' } });
    expect(result.ok).toBe(true);

    const after = doc.getText('source').toString();
    expect(after).toContain('# Project config');
    expect(after).toContain('# original');
    expect(after).toContain('dir: new');
    binding.dispose();
  });

  test('rejects schema-invalid scalar; Y.Text untouched', () => {
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');
    const before = doc.getText('source').toString();
    const binding = bindConfigDoc(provider, 'user');

    const result = binding.patch({ appearance: { theme: 'midnight' as 'dark' } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(isKnownConfigError(result.error)).toBe(true);
    if (!isKnownConfigError(result.error)) throw new Error('not known error');
    expect(result.error.code).toBe('SCHEMA_INVALID');
    if (result.error.code !== 'SCHEMA_INVALID') throw new Error('wrong code');
    expect(result.error.issues.length).toBeGreaterThan(0);
    expect(result.error.issues[0]?.path).toEqual(['appearance', 'theme']);

    expect(doc.getText('source').toString()).toBe(before);
    binding.dispose();
  });

  test('null-as-clear semantic via deleteIn', () => {
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');
    const binding = bindConfigDoc(provider, 'user');

    const result = binding.patch({ appearance: { theme: null } });
    expect(result.ok).toBe(true);

    const after = doc.getText('source').toString();
    expect(after).not.toContain('theme: dark');
    expect(binding.current().appearance?.theme).toBeUndefined();
    binding.dispose();
  });

  test('self-heals from corrupt Y.Text — patch lands on a fresh doc, dropping the bad bytes', () => {
    doc.getText('source').insert(0, 'theme: light\nappearance:\ntheme: light\n');
    const binding = bindConfigDoc(provider, 'project');

    const result = binding.patch({ content: { dir: 'docs' } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected self-heal recovery');
    const after = doc.getText('source').toString();
    expect(after).toContain('content:');
    expect(after).toContain('dir: docs');
    expect(after.match(/^theme:/gm)?.length ?? 0).toBe(0);
    binding.dispose();
  });

  test('self-heals from non-mapping top-level (e.g., scalar or array)', () => {
    doc.getText('source').insert(0, '- not a mapping\n- also not\n');
    const binding = bindConfigDoc(provider, 'project');

    const result = binding.patch({ content: { dir: 'docs' } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected self-heal recovery');
    const after = doc.getText('source').toString();
    expect(after).toContain('content:');
    expect(after).not.toContain('not a mapping');
    binding.dispose();
  });

  test('after dispose, patch returns WRITE_ERROR', () => {
    const binding = bindConfigDoc(provider, 'project');
    binding.dispose();

    const result = binding.patch({ content: { dir: 'docs' } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    if (!isKnownConfigError(result.error)) throw new Error('not known error');
    expect(result.error.code).toBe('WRITE_ERROR');
  });
});

describe('bindConfigDoc — subscribe()', () => {
  test('listener fires on Y.Text change after subscribe', () => {
    const binding = bindConfigDoc(provider, 'user');
    const received: Array<unknown> = [];

    const unsub = binding.subscribe((c) => {
      received.push(c.appearance?.theme);
    });

    binding.patch({ appearance: { theme: 'dark' } });
    expect(received).toEqual(['dark']);

    binding.patch({ appearance: { theme: 'light' } });
    expect(received).toEqual(['dark', 'light']);

    unsub();
    binding.patch({ appearance: { theme: 'system' } });
    expect(received).toEqual(['dark', 'light']);
    binding.dispose();
  });

  test('listener does NOT fire synchronously on subscribe', () => {
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');
    const binding = bindConfigDoc(provider, 'user');
    const received: Array<unknown> = [];

    binding.subscribe((c) => {
      received.push(c.appearance?.theme);
    });

    expect(received).toEqual([]);
    binding.dispose();
  });

  test('listener fires on provider synced event (reconnect-fresh-value)', () => {
    doc.getText('source').insert(0, 'appearance:\n  theme: dark\n');
    const binding = bindConfigDoc(provider, 'user');
    const received: Array<unknown> = [];
    binding.subscribe((c) => {
      received.push(c.appearance?.theme);
    });

    provider.emitSynced();

    expect(received).toEqual(['dark']);
    binding.dispose();
  });

  test('listener exception is caught — does not break other listeners', () => {
    const binding = bindConfigDoc(provider, 'user');
    const ok: Array<unknown> = [];

    binding.subscribe(() => {
      throw new Error('boom');
    });
    binding.subscribe((c) => {
      ok.push(c.appearance?.theme);
    });

    binding.patch({ appearance: { theme: 'dark' } });
    expect(ok).toEqual(['dark']);
    binding.dispose();
  });

  test('multiple subscribers fire in registration order', () => {
    const binding = bindConfigDoc(provider, 'user');
    const order: number[] = [];

    binding.subscribe(() => order.push(1));
    binding.subscribe(() => order.push(2));
    binding.subscribe(() => order.push(3));

    binding.patch({ appearance: { theme: 'dark' } });
    expect(order).toEqual([1, 2, 3]);
    binding.dispose();
  });
});

describe('bindConfigDoc — hasSynced() / subscribeSynced()', () => {
  test('hasSynced returns false until first synced event, true thereafter', () => {
    const binding = bindConfigDoc(provider, 'project-local');
    expect(binding.hasSynced()).toBe(false);

    provider.emitSynced();
    expect(binding.hasSynced()).toBe(true);

    provider.emitSynced();
    expect(binding.hasSynced()).toBe(true);

    binding.dispose();
  });

  test('subscribeSynced fires once on first synced event when subscribed before sync', () => {
    const binding = bindConfigDoc(provider, 'project-local');
    let calls = 0;
    binding.subscribeSynced(() => {
      calls += 1;
    });

    expect(calls).toBe(0);
    provider.emitSynced();
    expect(calls).toBe(1);

    provider.emitSynced();
    provider.emitSynced();
    expect(calls).toBe(1);

    binding.dispose();
  });

  test('subscribeSynced after first sync fires asynchronously on next microtask', async () => {
    const binding = bindConfigDoc(provider, 'project-local');
    provider.emitSynced();
    expect(binding.hasSynced()).toBe(true);

    let calls = 0;
    binding.subscribeSynced(() => {
      calls += 1;
    });
    expect(calls).toBe(0);
    await Promise.resolve();
    expect(calls).toBe(1);

    binding.dispose();
  });

  test('subscribeSynced returned unsubscribe cancels a pending pre-sync listener', () => {
    const binding = bindConfigDoc(provider, 'project-local');
    let calls = 0;
    const unsub = binding.subscribeSynced(() => {
      calls += 1;
    });
    unsub();

    provider.emitSynced();
    expect(calls).toBe(0);
    binding.dispose();
  });

  test('subscribeSynced returned unsubscribe cancels a queued post-sync listener', async () => {
    const binding = bindConfigDoc(provider, 'project-local');
    provider.emitSynced();

    let calls = 0;
    const unsub = binding.subscribeSynced(() => {
      calls += 1;
    });
    unsub();

    await Promise.resolve();
    expect(calls).toBe(0);
    binding.dispose();
  });

  test('subscribeSynced on already-synced binding, disposed before microtask fires, does not fire', async () => {
    const binding = bindConfigDoc(provider, 'project-local');
    provider.emitSynced();

    let calls = 0;
    binding.subscribeSynced(() => {
      calls += 1;
    });
    binding.dispose();

    await Promise.resolve();
    expect(calls).toBe(0);
  });

  test('subscribeSynced after dispose returns a no-op unsubscribe and never fires', async () => {
    const binding = bindConfigDoc(provider, 'project-local');
    binding.dispose();

    let calls = 0;
    const unsub = binding.subscribeSynced(() => {
      calls += 1;
    });
    unsub();

    await Promise.resolve();
    expect(calls).toBe(0);
  });

  test('synced listener exception does not break sibling listeners', () => {
    const binding = bindConfigDoc(provider, 'project-local');
    const order: number[] = [];
    binding.subscribeSynced(() => {
      throw new Error('boom');
    });
    binding.subscribeSynced(() => {
      order.push(2);
    });

    provider.emitSynced();
    expect(order).toEqual([2]);
    binding.dispose();
  });
});

describe('bindConfigDoc — dispose()', () => {
  test('clears Y.Text observer + provider listener + listeners set', () => {
    const binding = bindConfigDoc(provider, 'project');
    binding.subscribe(() => {});

    expect(provider.syncedListenerCount()).toBe(1);
    binding.dispose();
    expect(provider.syncedListenerCount()).toBe(0);

    let fired = false;
    binding.subscribe(() => {
      fired = true;
    });
    doc.getText('source').insert(0, 'content:\n  dir: docs\n');
    expect(fired).toBe(false);
  });

  test('idempotent — calling dispose twice is safe', () => {
    const binding = bindConfigDoc(provider, 'project');
    binding.dispose();
    expect(() => binding.dispose()).not.toThrow();
  });
});

describe('bindConfigDoc — project-local scope', () => {
  test('patch + current round-trip: writes and reads back through Y.Text', () => {
    const binding = bindConfigDoc(provider, 'project-local');
    const result = binding.patch({ autoSync: { enabled: true } });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.appliedPaths).toEqual(['autoSync.enabled']);

    const after = binding.current();
    expect(after.autoSync?.enabled).toBe(true);

    const ytext = doc.getText('source').toString();
    expect(ytext).toContain('autoSync:');
    expect(ytext).toContain('enabled: true');
    binding.dispose();
  });

  test('subscribe fires on patch under project-local scope', () => {
    const binding = bindConfigDoc(provider, 'project-local');
    const received: Array<unknown> = [];
    binding.subscribe((c) => {
      received.push(c.autoSync?.enabled);
    });

    binding.patch({ autoSync: { enabled: false } });
    expect(received).toEqual([false]);

    binding.patch({ autoSync: { enabled: true } });
    expect(received).toEqual([false, true]);
    binding.dispose();
  });
});

describe('bindConfigDoc — scope-violation gate', () => {
  test('user binding rejects a project-local field with SCOPE_VIOLATION; Y.Text untouched', () => {
    const before = doc.getText('source').toString();
    const binding = bindConfigDoc(provider, 'user');

    const result = binding.patch({ autoSync: { enabled: true } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected SCOPE_VIOLATION');
    expect(isKnownConfigError(result.error)).toBe(true);
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('SCOPE_VIOLATION');
    if (result.error.code !== 'SCOPE_VIOLATION') throw new Error('wrong code');
    expect(result.error.path).toEqual(['autoSync', 'enabled']);
    expect(result.error.expectedScope).toBe('project-local');
    expect(result.error.actualScope).toBe('user');

    expect(doc.getText('source').toString()).toBe(before);
    binding.dispose();
  });

  test('project binding rejects a project-local field with SCOPE_VIOLATION', () => {
    const binding = bindConfigDoc(provider, 'project');
    const result = binding.patch({ autoSync: { enabled: false } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected SCOPE_VIOLATION');
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('SCOPE_VIOLATION');
    if (result.error.code !== 'SCOPE_VIOLATION') throw new Error('wrong code');
    expect(result.error.expectedScope).toBe('project-local');
    expect(result.error.actualScope).toBe('project');
    binding.dispose();
  });

  test('project-local binding rejects a user field (appearance.theme) with SCOPE_VIOLATION', () => {
    const binding = bindConfigDoc(provider, 'project-local');
    const result = binding.patch({ appearance: { theme: 'dark' } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected SCOPE_VIOLATION');
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('SCOPE_VIOLATION');
    if (result.error.code !== 'SCOPE_VIOLATION') throw new Error('wrong code');
    expect(result.error.expectedScope).toBe('user');
    binding.dispose();
  });

  test('project-local binding rejects a project field (content.dir) with SCOPE_VIOLATION', () => {
    const binding = bindConfigDoc(provider, 'project-local');
    const result = binding.patch({ content: { dir: 'docs' } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected SCOPE_VIOLATION');
    if (!isKnownConfigError(result.error)) throw new Error('expected known error');
    expect(result.error.code).toBe('SCOPE_VIOLATION');
    if (result.error.code !== 'SCOPE_VIOLATION') throw new Error('wrong code');
    expect(result.error.expectedScope).toBe('project');
    binding.dispose();
  });
});

describe('bindConfigDoc — multi-client / cross-process simulation (NR9 LWW)', () => {
  test('two simultaneous Y.Text replacements via Yjs delta sync — final state is one of the two', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const provA = createMockProvider(docA);
    const provB = createMockProvider(docB);

    const seed = 'appearance:\n  theme: system\n';
    docA.getText('source').insert(0, seed);
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    const bindingA = bindConfigDoc(provA, 'user');
    const bindingB = bindConfigDoc(provB, 'user');

    const resA = bindingA.patch({ appearance: { theme: 'dark' } });
    const resB = bindingB.patch({ appearance: { theme: 'light' } });
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);

    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

    expect(docA.getText('source').toString()).toBe(docB.getText('source').toString());

    const finalConfig = bindingA.current();
    expect(finalConfig).toBeDefined();

    bindingA.dispose();
    bindingB.dispose();
    docA.destroy();
    docB.destroy();
  });

  test('external Y.Text replacement (file-watcher path) fires subscribers', () => {
    const binding = bindConfigDoc(provider, 'user');
    const received: Array<unknown> = [];
    binding.subscribe((c) => {
      received.push(c.appearance?.theme);
    });

    const ytext = doc.getText('source');
    doc.transact(() => {
      ytext.insert(0, 'appearance:\n  theme: dark\n');
    });

    expect(received).toEqual(['dark']);
    binding.dispose();
  });
});

/**
 * Unit tests for the three sibling write-side primitives in
 * `bridge-intake.ts` — the shared substrate of the Y.Text-is-truth
 * contract (precedent #38). Each primitive owns one paired-write
 * semantics and gets its own `describe` block here:
 *
 *   - `composeAndWriteRawBody` — file-watcher + agent-write semantics
 *     (parse → ytext-first applyFastDiff → fragment derive). Item-
 *     preserving via character-level DMP.
 *   - `replaceRawBody` — rollback semantics (parse → ytext-first FULL
 *     OVERWRITE delete/insert → fragment derive). The non-incremental
 *     replacement is the load-bearing signal to Y.UndoManager that this
 *     is a rollback, not an edit; DMP-based diff would over-preserve
 *     Items the user explicitly rolled back.
 *   - `deriveFragmentFromYtext` — agent-undo semantics (NO ytext write;
 *     UM.undo() has already mutated ytext to the post-undo state, this
 *     primitive only re-derives the fragment).
 *
 * Properties exercised across the three blocks:
 *   - Y.Text receives raw bytes verbatim (no canonicalization)
 *   - XmlFragment derives from `parse(body)` via updateYFragment
 *   - Both writes are atomic inside the caller's outer transact
 *   - Write order is ytext-first then fragment
 *   - Whitespace-meaningful bytes (leading/trailing newlines) survive
 *   - Source-form delimiters (`__foo__` not `**foo**`) survive
 *   - No primitive calls doc.transact() itself (caller-wrap is mandatory)
 *   - The primitive distinguishing-features hold under regression
 *     (replaceRawBody = full overwrite; deriveFragmentFromYtext = zero
 *     ytext writes)
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { normalizeBridge, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { ROLLBACK_ORIGIN } from './api-extension.ts';
import {
  composeAndWriteRawBody,
  deriveFragmentFromYtext,
  replaceRawBody,
} from './bridge-intake.ts';
import { FILE_WATCHER_ORIGIN } from './external-change.ts';
import { mdManager, schema } from './md-manager.ts';

describe('composeAndWriteRawBody — primitive contract', () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  test('writes raw bytes to Y.Text verbatim — no canonicalization', () => {
    doc.transact(() => {
      composeAndWriteRawBody(doc, '# Heading\n\nbody\n', 'agent');
    }, FILE_WATCHER_ORIGIN);

    expect(doc.getText('source').toString()).toBe('# Heading\n\nbody\n');
  });

  test('preserves source-form delimiter `__foo__` (NOT canonicalized to `**foo**`)', () => {
    doc.transact(() => {
      composeAndWriteRawBody(doc, '__foo__\n', 'agent');
    }, FILE_WATCHER_ORIGIN);

    expect(doc.getText('source').toString()).toBe('__foo__\n');
  });

  test('preserves source-form delimiter `_foo_` (NOT canonicalized to `*foo*`)', () => {
    doc.transact(() => {
      composeAndWriteRawBody(doc, '_emphasis_\n', 'agent');
    }, FILE_WATCHER_ORIGIN);

    expect(doc.getText('source').toString()).toBe('_emphasis_\n');
  });

  test('preserves source-form fence `~~~` (NOT canonicalized to ``` `)', () => {
    doc.transact(() => {
      composeAndWriteRawBody(doc, '~~~js\nconst x = 1;\n~~~\n', 'agent');
    }, FILE_WATCHER_ORIGIN);

    expect(doc.getText('source').toString()).toBe('~~~js\nconst x = 1;\n~~~\n');
  });

  test('preserves doc-start `---` thematic break (was: canonicalized to `***`)', () => {
    doc.transact(() => {
      composeAndWriteRawBody(doc, '---\n', 'agent');
    }, FILE_WATCHER_ORIGIN);

    // Under contract, ytext holds the raw user form. `***` and `---` at doc
    // start are tolerance-equal per normalizeBridge, but ytext bytes preserve
    // what the user typed.
    expect(doc.getText('source').toString()).toBe('---\n');
  });

  test('preserves frontmatter region byte-equal (no FM canonicalization)', () => {
    const content = '---\ntags:\n  - characters\n  - air-nomads\n---\n# Aang\n';
    doc.transact(() => {
      composeAndWriteRawBody(doc, content, 'agent');
    }, FILE_WATCHER_ORIGIN);

    expect(doc.getText('source').toString()).toBe(content);
    const { frontmatter } = stripFrontmatter(doc.getText('source').toString());
    expect(frontmatter).toBe('---\ntags:\n  - characters\n  - air-nomads\n---\n');
  });

  test('preserves CRLF line endings verbatim', () => {
    const content = '# Heading\r\n\r\nbody\r\n';
    doc.transact(() => {
      composeAndWriteRawBody(doc, content, 'agent');
    }, FILE_WATCHER_ORIGIN);

    expect(doc.getText('source').toString()).toBe(content);
  });

  test('preserves UTF-8 BOM verbatim', () => {
    const content = '﻿# Heading\n';
    doc.transact(() => {
      composeAndWriteRawBody(doc, content, 'agent');
    }, FILE_WATCHER_ORIGIN);

    expect(doc.getText('source').toString()).toBe(content);
  });

  test('XmlFragment derives from parse(body) — fragment matches structural form', () => {
    doc.transact(() => {
      composeAndWriteRawBody(doc, '# Heading\n\nbody\n', 'agent');
    }, FILE_WATCHER_ORIGIN);

    const xmlFragment = doc.getXmlFragment('default');
    expect(xmlFragment.length).toBeGreaterThan(0);
    // Heading + paragraph (2 children).
    expect(xmlFragment.length).toBe(2);
  });

  test('XmlFragment does NOT contain frontmatter content', () => {
    const content = '---\ntitle: Test\n---\n# Heading\n';
    doc.transact(() => {
      composeAndWriteRawBody(doc, content, 'agent');
    }, FILE_WATCHER_ORIGIN);

    const xmlFragment = doc.getXmlFragment('default');
    const xmlString = xmlFragment.toString();
    expect(xmlString).not.toContain('title: Test');
    expect(xmlString).not.toContain('---');
  });

  test('bridge invariant holds: normalizeBridge(ytext) === normalizeBridge(serialize(fragment) + fm)', () => {
    const content = '---\ntitle: Test\n---\n# Heading\n\nbody\n';
    doc.transact(() => {
      composeAndWriteRawBody(doc, content, 'agent');
    }, FILE_WATCHER_ORIGIN);

    const ytext = doc.getText('source').toString();
    const xmlFragment = doc.getXmlFragment('default');
    const fragmentBody = mdManager.serialize(
      yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
    );
    const { frontmatter } = stripFrontmatter(ytext);
    const fragmentFull = `${frontmatter}${fragmentBody}`;

    expect(normalizeBridge(ytext)).toBe(normalizeBridge(fragmentFull));
  });

  test('idempotent — second call with same content does not mutate Y.Text', () => {
    const content = '# Heading\n\nbody\n';
    doc.transact(() => {
      composeAndWriteRawBody(doc, content, 'agent');
    }, FILE_WATCHER_ORIGIN);

    let textMutations = 0;
    const observer = (): void => {
      textMutations++;
    };
    const ytext = doc.getText('source');
    ytext.observe(observer);

    doc.transact(() => {
      composeAndWriteRawBody(doc, content, 'agent');
    }, FILE_WATCHER_ORIGIN);

    ytext.unobserve(observer);
    expect(textMutations).toBe(0);
  });

  test('overwrites existing content — replace semantics from caller', () => {
    doc.transact(() => {
      composeAndWriteRawBody(doc, '# Old\n', 'agent');
    }, FILE_WATCHER_ORIGIN);
    doc.transact(() => {
      composeAndWriteRawBody(doc, '# New\n', 'agent');
    }, FILE_WATCHER_ORIGIN);

    expect(doc.getText('source').toString()).toBe('# New\n');
  });

  test('does not call doc.transact() — caller-wrap is mandatory for atomicity', () => {
    // If the primitive itself called transact, the inner transact would be
    // observable as a separate transaction with a different origin. We don't
    // see two transactions here — only the caller's outer one. Validated by
    // counting transactions inside one caller-wrap block.
    let tx = 0;
    doc.on('beforeTransaction', () => {
      tx++;
    });

    doc.transact(() => {
      composeAndWriteRawBody(doc, '# Test\n', 'agent');
    }, FILE_WATCHER_ORIGIN);

    expect(tx).toBe(1);
  });

  test('Y.Text is mutated before XmlFragment (write-order contract per FR-30)', () => {
    // Pins the load-bearing write order documented at the top of
    // bridge-intake.ts: applyFastDiff(ytext, ...) MUST run before
    // updateYFragment(xmlFragment, ...). Under the contract (precedent #38,
    // Y.Text-is-truth) a partial failure where applyFastDiff succeeds but
    // updateYFragment then throws leaves ytext correct, and the next observer
    // dispatch re-derives fragment via parse(ytext). Reversed order would
    // leave fragment correct and ytext stale; Observer B Phase 1 on the
    // next non-paired ytext mutation would re-derive fragment from STALE
    // ytext bytes, silently reverting the write.
    //
    // Yjs's transaction.changed is a Map preserved in insertion order; the
    // type that received its FIRST mutation first fires its observer first.
    // Observers dispatch post-transaction in that order. If a future refactor
    // reverses the call sequence, this test catches it via dispatch order.
    const events: string[] = [];
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    xmlFragment.observeDeep(() => events.push('xml'));
    ytext.observe(() => events.push('ytext'));

    doc.transact(() => {
      composeAndWriteRawBody(doc, '# Test\n', 'agent');
    }, FILE_WATCHER_ORIGIN);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.indexOf('ytext')).toBeLessThan(events.indexOf('xml'));
  });

  test('writes XmlFragment + Y.Text atomically inside one caller-wrap transact', () => {
    let xmlObserved = false;
    let textObserved = false;
    let observedTxOrigin: unknown;
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    xmlFragment.observeDeep((_events, transaction) => {
      xmlObserved = true;
      observedTxOrigin = transaction.origin;
    });
    ytext.observe((_event, transaction) => {
      textObserved = true;
      observedTxOrigin = transaction.origin;
    });

    doc.transact(() => {
      composeAndWriteRawBody(doc, '# Test\n', 'agent');
    }, FILE_WATCHER_ORIGIN);

    expect(xmlObserved).toBe(true);
    expect(textObserved).toBe(true);
    expect(observedTxOrigin).toBe(FILE_WATCHER_ORIGIN);
  });

  test('preserves intentional leading whitespace (no .trim() per FR-30 D8)', () => {
    const content = '\n\n# Heading\n';
    doc.transact(() => {
      composeAndWriteRawBody(doc, content, 'agent');
    }, FILE_WATCHER_ORIGIN);

    expect(doc.getText('source').toString()).toBe(content);
  });

  test('handles empty content without throwing', () => {
    expect(() => {
      doc.transact(() => {
        composeAndWriteRawBody(doc, '', 'agent');
      }, FILE_WATCHER_ORIGIN);
    }).not.toThrow();

    expect(doc.getText('source').toString()).toBe('');
  });

  test('embedResolver context is threaded through to mdManager.parseWithFallback', () => {
    let calledWithBasename = '';
    let calledWithSourcePath = '';
    const embedResolver = {
      resolveEmbed: (basename: string, sourcePath: string): string | null => {
        calledWithBasename = basename;
        calledWithSourcePath = sourcePath;
        return `/resolved/${basename}`;
      },
      sourcePath: 'docs/feature.md',
    };

    doc.transact(() => {
      composeAndWriteRawBody(doc, '![[photo.png]]\n', 'file-watcher', embedResolver);
    }, FILE_WATCHER_ORIGIN);

    expect(calledWithBasename).toBe('photo.png');
    expect(calledWithSourcePath).toBe('docs/feature.md');
  });
});

describe('replaceRawBody — primitive contract', () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  test('writes raw bytes to Y.Text verbatim — no canonicalization', () => {
    doc.transact(() => {
      replaceRawBody(doc, '# Heading\n\nbody\n');
    }, ROLLBACK_ORIGIN);

    expect(doc.getText('source').toString()).toBe('# Heading\n\nbody\n');
  });

  test('preserves source-form delimiters (`__foo__` survives, `_bar_` survives, `~~~` fence survives)', () => {
    // Same byte-preservation property as composeAndWriteRawBody: rollback
    // is "restore historical bytes verbatim", NOT "canonicalize on write."
    doc.transact(() => {
      replaceRawBody(doc, '__foo__\n_bar_\n~~~js\nconst x=1;\n~~~\n');
    }, ROLLBACK_ORIGIN);

    expect(doc.getText('source').toString()).toBe('__foo__\n_bar_\n~~~js\nconst x=1;\n~~~\n');
  });

  test('preserves frontmatter region byte-equal (no FM canonicalization)', () => {
    const content = '---\ntitle: doc\nfoo: bar\n---\n\n# Body\n';
    doc.transact(() => {
      replaceRawBody(doc, content);
    }, ROLLBACK_ORIGIN);

    expect(doc.getText('source').toString()).toBe(content);
  });

  test('preserves CRLF line endings verbatim', () => {
    const content = '# Heading\r\n\r\nbody line one\r\nbody line two\r\n';
    doc.transact(() => {
      replaceRawBody(doc, content);
    }, ROLLBACK_ORIGIN);

    expect(doc.getText('source').toString()).toBe(content);
  });

  test('XmlFragment derives from parse(body) — fragment matches structural form', () => {
    doc.transact(() => {
      replaceRawBody(doc, '# Heading\n\nbody paragraph\n');
    }, ROLLBACK_ORIGIN);

    const xmlFragment = doc.getXmlFragment('default');
    const pmRoot = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema);
    expect(pmRoot.firstChild?.type.name).toBe('heading');
    expect(pmRoot.lastChild?.type.name).toBe('paragraph');
  });

  test('bridge invariant holds: normalizeBridge(ytext) === normalizeBridge(serialize(fragment) + fm)', () => {
    const content = '---\ntitle: t\n---\n\n# H\n\nbody\n';
    doc.transact(() => {
      replaceRawBody(doc, content);
    }, ROLLBACK_ORIGIN);

    const ytext = doc.getText('source').toString();
    const xmlFragment = doc.getXmlFragment('default');
    const pmRoot = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema);
    const serialized = mdManager.serialize(pmRoot.toJSON());
    const { frontmatter } = stripFrontmatter(content);
    const reconstituted = `${frontmatter}\n\n${serialized}`;
    expect(normalizeBridge(ytext)).toBe(normalizeBridge(reconstituted));
  });

  test('does not call doc.transact() — caller-wrap is mandatory for atomicity', () => {
    let tx = 0;
    doc.on('beforeTransaction', () => {
      tx++;
    });

    doc.transact(() => {
      replaceRawBody(doc, '# Test\n');
    }, ROLLBACK_ORIGIN);

    expect(tx).toBe(1);
  });

  test('Y.Text is mutated before XmlFragment (write-order contract per FR-30 D4)', () => {
    // Same write-order property as composeAndWriteRawBody, applied to the
    // delete+insert path. Reversed order would re-introduce the silent-
    // revert failure mode the file-level rationale enumerates.
    const events: string[] = [];
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    xmlFragment.observeDeep(() => events.push('xml'));
    ytext.observe(() => events.push('ytext'));

    doc.transact(() => {
      replaceRawBody(doc, '# Test\n');
    }, ROLLBACK_ORIGIN);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.indexOf('ytext')).toBeLessThan(events.indexOf('xml'));
  });

  test('writes XmlFragment + Y.Text atomically inside one caller-wrap transact under ROLLBACK_ORIGIN', () => {
    let xmlObserved = false;
    let textObserved = false;
    let observedTxOrigin: unknown;
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    xmlFragment.observeDeep((_events, transaction) => {
      xmlObserved = true;
      observedTxOrigin = transaction.origin;
    });
    ytext.observe((_event, transaction) => {
      textObserved = true;
      observedTxOrigin = transaction.origin;
    });

    doc.transact(() => {
      replaceRawBody(doc, '# Test\n');
    }, ROLLBACK_ORIGIN);

    expect(xmlObserved).toBe(true);
    expect(textObserved).toBe(true);
    expect(observedTxOrigin).toBe(ROLLBACK_ORIGIN);
  });

  test('FULL OVERWRITE distinguishing-feature: total ytext bytes deleted+inserted equals new content length, not DMP-incremental', () => {
    // The load-bearing distinction between replaceRawBody and
    // composeAndWriteRawBody. File-level rationale (bridge-intake.ts):
    //   "The full overwrite (vs applyFastDiff's incremental DMP) is the
    //    load-bearing signal to Y.UndoManager that this is a non-
    //    incremental replacement: rollback discards the user's recent
    //    edits, so DMP-based Item preservation would defeat the rollback
    //    by re-using Items the user explicitly rolled back."
    //
    // We assert the property by counting characters added in the second
    // call's ytext.observe event. With incremental DMP (composeAndWrite),
    // changing a single character would emit a delta of 1; with full
    // overwrite, the delta covers ALL inserted chars (because the prior
    // bytes were deleted first). The test pins the latter shape.
    doc.transact(() => {
      replaceRawBody(doc, '# Old long original heading\n\nbody\n');
    }, ROLLBACK_ORIGIN);

    const ytext = doc.getText('source');
    let insertCharCount = 0;
    let deleteCharCount = 0;
    const observer = (event: Y.YTextEvent): void => {
      for (const change of event.changes.delta) {
        if (change.insert && typeof change.insert === 'string') {
          insertCharCount += change.insert.length;
        }
        if (change.delete) {
          deleteCharCount += change.delete;
        }
      }
    };
    ytext.observe(observer);

    const newContent = '# New short heading\n';
    doc.transact(() => {
      replaceRawBody(doc, newContent);
    }, ROLLBACK_ORIGIN);

    ytext.unobserve(observer);
    // Full overwrite shape: the entire new content is inserted, the entire
    // prior content is deleted. An incremental DMP shape would show much
    // smaller deltas (e.g. delete of "Old long original heading" and insert
    // of "New short heading", retaining the surrounding shared bytes).
    expect(insertCharCount).toBe(newContent.length);
    expect(deleteCharCount).toBe('# Old long original heading\n\nbody\n'.length);
  });

  test('idempotent — second call with identical content does not mutate Y.Text', () => {
    doc.transact(() => {
      replaceRawBody(doc, '# Heading\n');
    }, ROLLBACK_ORIGIN);

    let textMutations = 0;
    const observer = (): void => {
      textMutations++;
    };
    const ytext = doc.getText('source');
    ytext.observe(observer);

    doc.transact(() => {
      replaceRawBody(doc, '# Heading\n');
    }, ROLLBACK_ORIGIN);

    ytext.unobserve(observer);
    expect(textMutations).toBe(0);
  });

  test('handles empty content without throwing', () => {
    expect(() => {
      doc.transact(() => {
        replaceRawBody(doc, '');
      }, ROLLBACK_ORIGIN);
    }).not.toThrow();
    expect(doc.getText('source').toString()).toBe('');
  });
});

describe('deriveFragmentFromYtext — primitive contract', () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
  });

  test('writes ZERO bytes to Y.Text — distinguishing-feature pin', () => {
    // Pins the load-bearing distinction between deriveFragmentFromYtext
    // (used by agent-undo, which mutates ytext via UM.undo() BEFORE this
    // primitive runs) and composeAndWriteRawBody / replaceRawBody (which
    // both write ytext). The agent-undo flow MUST NOT double-mutate ytext
    // — the UM has already consumed the inverse delta. A regression that
    // accidentally writes ytext here would corrupt the UM stack and
    // surface as a confusing far-from-cause failure (e.g. attribution
    // drift on subsequent undo calls).
    //
    // Seed ytext with content the FILE_WATCHER_ORIGIN write so the
    // ytext.observe() under deriveFragmentFromYtext counts only its own
    // writes (not the seed transaction's).
    doc.transact(() => {
      composeAndWriteRawBody(doc, '# Heading\n\nbody\n', 'file-watcher');
    }, FILE_WATCHER_ORIGIN);

    let textMutations = 0;
    const observer = (): void => {
      textMutations++;
    };
    const ytext = doc.getText('source');
    ytext.observe(observer);

    doc.transact(() => {
      deriveFragmentFromYtext(doc);
    }, FILE_WATCHER_ORIGIN);

    ytext.unobserve(observer);
    expect(textMutations).toBe(0);
  });

  test('preserves Y.Text bytes verbatim across the call', () => {
    const seed = '# Heading\n\nbody\n';
    doc.transact(() => {
      composeAndWriteRawBody(doc, seed, 'file-watcher');
    }, FILE_WATCHER_ORIGIN);

    doc.transact(() => {
      deriveFragmentFromYtext(doc);
    }, FILE_WATCHER_ORIGIN);

    expect(doc.getText('source').toString()).toBe(seed);
  });
});

/**
 * Unit tests for the two sibling write-side primitives in
 * `bridge-intake.ts` — the shared substrate of the Y.Text-is-truth
 * contract (precedent #38). Each primitive owns one write semantics and
 * gets its own `describe` block here:
 *
 *   - `composeAndWriteRawBody` — file-watcher + agent-write semantics
 *     (line-aligned applyFastDiff). Item-preserving via character-level
 *     DMP.
 *   - `replaceRawBody` — rollback semantics (FULL OVERWRITE
 *     delete/insert). The non-incremental replacement is the
 *     load-bearing signal to Y.UndoManager that this is a rollback, not
 *     an edit; DMP-based diff would over-preserve Items the user
 *     explicitly rolled back.
 *
 * Properties exercised across both blocks:
 *   - Y.Text receives raw bytes verbatim (no canonicalization)
 *   - The write lands inside the caller's outer transact, under the
 *     caller's origin
 *   - Whitespace-meaningful bytes (leading/trailing newlines) survive
 *   - Source-form delimiters (`__foo__` not `**foo**`) survive
 *   - Neither primitive calls doc.transact() itself (caller-wrap is
 *     mandatory)
 *   - `replaceRawBody`'s full-overwrite distinguishing-feature holds
 *     under regression
 */

import { stripFrontmatter } from '@inkeep/open-knowledge-core';
import { beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { ROLLBACK_ORIGIN } from './api-extension.ts';
import { composeAndWriteRawBody, replaceRawBody } from './bridge-intake.ts';
import { FILE_WATCHER_ORIGIN } from './external-change.ts';

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
    let tx = 0;
    doc.on('beforeTransaction', () => {
      tx++;
    });

    doc.transact(() => {
      composeAndWriteRawBody(doc, '# Test\n', 'agent');
    }, FILE_WATCHER_ORIGIN);

    expect(tx).toBe(1);
  });

  test('writes Y.Text inside the caller-wrap transact, under the caller origin', () => {
    let textObserved = false;
    let observedTxOrigin: unknown;
    const ytext = doc.getText('source');

    ytext.observe((_event, transaction) => {
      textObserved = true;
      observedTxOrigin = transaction.origin;
    });

    doc.transact(() => {
      composeAndWriteRawBody(doc, '# Test\n', 'agent');
    }, FILE_WATCHER_ORIGIN);

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

  test('writes Y.Text inside the caller-wrap transact, under ROLLBACK_ORIGIN', () => {
    let textObserved = false;
    let observedTxOrigin: unknown;
    const ytext = doc.getText('source');

    ytext.observe((_event, transaction) => {
      textObserved = true;
      observedTxOrigin = transaction.origin;
    });

    doc.transact(() => {
      replaceRawBody(doc, '# Test\n');
    }, ROLLBACK_ORIGIN);

    expect(textObserved).toBe(true);
    expect(observedTxOrigin).toBe(ROLLBACK_ORIGIN);
  });

  test('FULL OVERWRITE distinguishing-feature: total ytext bytes deleted+inserted equals new content length, not DMP-incremental', () => {
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

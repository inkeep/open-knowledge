import type { LintDiagnostic, LintTextEdit } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { applyLintFixes, collectFixes, LINT_SOURCE_FIXED_EVENT } from './apply-lint-fix.ts';
import { subscribePreviewTabPromotion } from './preview-tab-promotion';

function docWith(source: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, source);
  return doc;
}
function edit(sl: number, sc: number, el: number, ec: number, newText: string): LintTextEdit {
  return {
    range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
    newText,
  };
}

function withWindowStub(run: (win: EventTarget) => void): void {
  const holder = globalThis as { window?: unknown };
  const prior = holder.window;
  const win = new EventTarget();
  holder.window = win;
  try {
    run(win);
  } finally {
    holder.window = prior;
  }
}

describe('applyLintFixes', () => {
  test('removes a trailing-space run (MD009-style, single-line delete)', () => {
    const doc = docWith('# Title\n\nParagraph here.   \n');
    applyLintFixes({ document: doc }, [edit(2, 15, 2, 18, '')], 'doc');
    expect(doc.getText('source').toString()).toBe('# Title\n\nParagraph here.\n');
  });

  test('replaces a hard tab (MD010-style, insert replaces range)', () => {
    const doc = docWith('a\tb\n');
    applyLintFixes({ document: doc }, [edit(0, 1, 0, 2, '  ')], 'doc');
    expect(doc.getText('source').toString()).toBe('a  b\n');
  });

  test('applies multiple edits high→low without offset drift', () => {
    const doc = docWith('x   \ny   \n');
    applyLintFixes({ document: doc }, [edit(0, 1, 0, 4, ''), edit(1, 1, 1, 4, '')], 'doc');
    expect(doc.getText('source').toString()).toBe('x\ny\n');
  });

  test('applies multiple edits in a single Y.Doc transaction', () => {
    const doc = docWith('x   \ny   \n');
    let updates = 0;
    doc.on('update', () => {
      updates += 1;
    });
    applyLintFixes({ document: doc }, [edit(0, 1, 0, 4, ''), edit(1, 1, 1, 4, '')], 'doc');
    expect(updates).toBe(1);
    expect(doc.getText('source').toString()).toBe('x\ny\n');
  });

  test('empty fix list is a no-op returning false', () => {
    const doc = docWith('unchanged\n');
    expect(applyLintFixes({ document: doc }, [], 'doc')).toBe(false);
    expect(doc.getText('source').toString()).toBe('unchanged\n');
  });

  test('pure insertion (from === to, non-empty newText) inserts without deleting', () => {
    const doc = docWith('# Heading');
    applyLintFixes({ document: doc }, [edit(0, 9, 0, 9, '\n')], 'doc');
    expect(doc.getText('source').toString()).toBe('# Heading\n');
  });

  test('whole-line deletion (cross-line range) removes exactly one line', () => {
    const doc = docWith('# Title\n\npara\n\n\nextra blank\n');
    applyLintFixes({ document: doc }, [edit(3, 0, 4, 0, '')], 'doc');
    expect(doc.getText('source').toString()).toBe('# Title\n\npara\n\nextra blank\n');
  });

  test('applies an exact duplicate edit only once', () => {
    const doc = docWith('a\tb\n');
    applyLintFixes({ document: doc }, [edit(0, 1, 0, 2, '  '), edit(0, 1, 0, 2, '  ')], 'doc');
    expect(doc.getText('source').toString()).toBe('a  b\n');
  });

  test('skips an edit swallowed by an already-applied whole-line delete', () => {
    const doc = docWith('keep\nx\ty\nkeep\n');
    applyLintFixes({ document: doc }, [edit(1, 0, 2, 0, ''), edit(1, 1, 1, 2, '  ')], 'doc');
    expect(doc.getText('source').toString()).toBe('keep\nkeep\n');
  });

  test('applies touching (end-exclusive adjacent) edits from different diagnostics', () => {
    const doc = docWith('a\t\tb\n');
    applyLintFixes({ document: doc }, [edit(0, 1, 0, 2, ' '), edit(0, 2, 0, 3, ' ')], 'doc');
    expect(doc.getText('source').toString()).toBe('a  b\n');
  });

  test('multi-diagnostic combination applies all non-conflicting fixes', () => {
    const doc = docWith('a\tb   \n\n\npara');
    applyLintFixes(
      { document: doc },
      [edit(0, 1, 0, 2, '  '), edit(0, 3, 0, 6, ''), edit(2, 0, 3, 0, ''), edit(3, 4, 3, 4, '\n')],
      'doc',
    );
    expect(doc.getText('source').toString()).toBe('a  b\n\npara\n');
  });

  test('fires LINT_SOURCE_FIXED_EVENT once after a non-empty fix', () => {
    let fired = 0;
    withWindowStub((win) => {
      win.addEventListener(LINT_SOURCE_FIXED_EVENT, () => {
        fired += 1;
      });
      applyLintFixes({ document: docWith('a\tb\n') }, [edit(0, 1, 0, 2, '  ')], 'doc');
    });
    expect(fired).toBe(1);
  });

  test('does not fire LINT_SOURCE_FIXED_EVENT for an empty fix list', () => {
    let fired = 0;
    withWindowStub((win) => {
      win.addEventListener(LINT_SOURCE_FIXED_EVENT, () => {
        fired += 1;
      });
      applyLintFixes({ document: docWith('unchanged\n') }, [], 'doc');
    });
    expect(fired).toBe(0);
  });
});

describe('collectFixes', () => {
  const fixable: LintDiagnostic = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 'warning',
    source: 'markdownlint',
    code: 'MD010',
    message: 'x',
    fixes: [edit(0, 0, 0, 1, ' ')],
  };
  const plain: LintDiagnostic = { ...fixable, code: 'MD025', fixes: undefined };
  test('collectFixes flattens only fixable diagnostics', () => {
    expect(collectFixes([fixable, plain])).toHaveLength(1);
  });
});

describe('applyLintFixes — preview-tab promotion', () => {
  let unsubscribe: (() => void) | undefined;

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
  });

  test('a fix that lands announces the doc', () => {
    const promoted = vi.fn();
    unsubscribe = subscribePreviewTabPromotion(promoted);
    const doc = docWith('a\t\tb\n');

    applyLintFixes({ document: doc }, [edit(0, 1, 0, 2, ' ')], 'notes/thing');

    expect(promoted).toHaveBeenCalledWith('notes/thing');
  });

  test('an empty fix list announces nothing', () => {
    const promoted = vi.fn();
    unsubscribe = subscribePreviewTabPromotion(promoted);
    const doc = docWith('unchanged\n');

    applyLintFixes({ document: doc }, [], 'notes/thing');

    expect(promoted).not.toHaveBeenCalled();
  });

  test('a no-op edit still counts as applied, matching the return value', () => {
    const promoted = vi.fn();
    unsubscribe = subscribePreviewTabPromotion(promoted);
    const doc = docWith('keep\n');

    const applied = applyLintFixes({ document: doc }, [edit(9, 0, 9, 0, '')], 'notes/thing');

    expect(applied).toBe(true);
    expect(promoted).toHaveBeenCalledWith('notes/thing');
  });
});

import { describe, expect, test } from 'bun:test';
import type { LintDiagnostic, LintTextEdit } from '@inkeep/open-knowledge-core';
import * as Y from 'yjs';
import { applyLintFixes, collectFixes, LINT_SOURCE_FIXED_EVENT } from './apply-lint-fix.ts';

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

// `applyLintFixes` dispatches LINT_SOURCE_FIXED_EVENT on `window` (guarded by
// `typeof window !== 'undefined'`). The unit tier has no DOM, so install a bare
// EventTarget as `window` for the duration of the assertion and restore after —
// keeping the no-DOM contract intact for every other unit-tier test.
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
    // line 2 (0-based), delete the 3 trailing spaces at chars 15..18.
    applyLintFixes({ document: doc }, [edit(2, 15, 2, 18, '')]);
    expect(doc.getText('source').toString()).toBe('# Title\n\nParagraph here.\n');
  });

  test('replaces a hard tab (MD010-style, insert replaces range)', () => {
    const doc = docWith('a\tb\n');
    applyLintFixes({ document: doc }, [edit(0, 1, 0, 2, '  ')]);
    expect(doc.getText('source').toString()).toBe('a  b\n');
  });

  test('applies multiple edits high→low without offset drift', () => {
    const doc = docWith('x   \ny   \n'); // trailing spaces on two lines
    applyLintFixes({ document: doc }, [edit(0, 1, 0, 4, ''), edit(1, 1, 1, 4, '')]);
    expect(doc.getText('source').toString()).toBe('x\ny\n');
  });

  test('applies multiple edits in a single Y.Doc transaction', () => {
    // Atomicity is observable as exactly one `update` event: Y.js batches all
    // mutations inside one `transact()` into a single update regardless of edit
    // count. Two edits landing in two transactions would fire twice.
    const doc = docWith('x   \ny   \n');
    let updates = 0;
    doc.on('update', () => {
      updates += 1;
    });
    applyLintFixes({ document: doc }, [edit(0, 1, 0, 4, ''), edit(1, 1, 1, 4, '')]);
    expect(updates).toBe(1);
    expect(doc.getText('source').toString()).toBe('x\ny\n');
  });

  test('empty fix list is a no-op returning false', () => {
    const doc = docWith('unchanged\n');
    expect(applyLintFixes({ document: doc }, [])).toBe(false);
    expect(doc.getText('source').toString()).toBe('unchanged\n');
  });

  test('pure insertion (from === to, non-empty newText) inserts without deleting', () => {
    // MD047 (missing trailing newline) produces a pure-insertion fix: an edit
    // whose range is empty (start === end) with non-empty newText.
    const doc = docWith('# Heading');
    applyLintFixes({ document: doc }, [edit(0, 9, 0, 9, '\n')]);
    expect(doc.getText('source').toString()).toBe('# Heading\n');
  });

  test('whole-line deletion (cross-line range) removes exactly one line', () => {
    // fixInfoToEdit emits a cross-line range for deleteCount === -1 (MD012
    // multiple-blank-lines): { start: { line: N, character: 0 }, end: { line:
    // N + 1, character: 0 } }. Exercises offsetOf's newline arithmetic across
    // a line boundary — a wrong byte count here would corrupt the shared Y.Text.
    const doc = docWith('# Title\n\npara\n\n\nextra blank\n');
    applyLintFixes({ document: doc }, [edit(3, 0, 4, 0, '')]);
    expect(doc.getText('source').toString()).toBe('# Title\n\npara\n\nextra blank\n');
  });

  test('applies an exact duplicate edit only once', () => {
    // Two diagnostics (e.g. two rules flagging the same run) can carry
    // byte-identical fixes; compounding them would delete twice.
    const doc = docWith('a\tb\n');
    applyLintFixes({ document: doc }, [edit(0, 1, 0, 2, '  '), edit(0, 1, 0, 2, '  ')]);
    expect(doc.getText('source').toString()).toBe('a  b\n');
  });

  test('skips an edit swallowed by an already-applied whole-line delete', () => {
    // A whole-line delete (MD012 shape) containing another diagnostic's
    // same-line replace: applying both would delete bytes twice. Upstream
    // applyFixes skips the overlapped fix; the skipped issue re-surfaces on
    // the post-fix re-lint.
    const doc = docWith('keep\nx\ty\nkeep\n');
    applyLintFixes({ document: doc }, [
      edit(1, 0, 2, 0, ''), // delete line 1 entirely
      edit(1, 1, 1, 2, '  '), // replace the tab inside line 1
    ]);
    expect(doc.getText('source').toString()).toBe('keep\nkeep\n');
  });

  test('applies touching (end-exclusive adjacent) edits from different diagnostics', () => {
    // [2,3) and [1,2) touch at offset 2 but do not overlap — both must land.
    const doc = docWith('a\t\tb\n');
    applyLintFixes({ document: doc }, [edit(0, 1, 0, 2, ' '), edit(0, 2, 0, 3, ' ')]);
    expect(doc.getText('source').toString()).toBe('a  b\n');
  });

  test('multi-diagnostic combination applies all non-conflicting fixes', () => {
    const doc = docWith('a\tb   \n\n\npara');
    applyLintFixes({ document: doc }, [
      edit(0, 1, 0, 2, '  '), // MD010 hard tab
      edit(0, 3, 0, 6, ''), // MD009 trailing spaces
      edit(2, 0, 3, 0, ''), // MD012 extra blank line
      edit(3, 4, 3, 4, '\n'), // MD047 trailing newline
    ]);
    expect(doc.getText('source').toString()).toBe('a  b\n\npara\n');
  });

  test('fires LINT_SOURCE_FIXED_EVENT once after a non-empty fix', () => {
    let fired = 0;
    withWindowStub((win) => {
      win.addEventListener(LINT_SOURCE_FIXED_EVENT, () => {
        fired += 1;
      });
      applyLintFixes({ document: docWith('a\tb\n') }, [edit(0, 1, 0, 2, '  ')]);
    });
    expect(fired).toBe(1);
  });

  test('does not fire LINT_SOURCE_FIXED_EVENT for an empty fix list', () => {
    let fired = 0;
    withWindowStub((win) => {
      win.addEventListener(LINT_SOURCE_FIXED_EVENT, () => {
        fired += 1;
      });
      applyLintFixes({ document: docWith('unchanged\n') }, []);
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

// @vitest-environment jsdom
/**
 * Narrow integration for the source-mode target-existence layer: a real
 * `EditorView` with the extension installed, the audit fetch and CC1 push mocked
 * at its subscription boundary, proving the wiring the pure mapping test cannot
 * — settled findings render, a later settled plane heals them, and authored
 * bytes never change.
 */

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { ValidationDocResult } from '@inkeep/open-knowledge-core';
import { GFM } from '@lezer/markdown';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  resetLinkValidationPolicyForTest,
  setLinkValidationVisible,
} from '../link-validation-policy';

type LinkFinding = ValidationDocResult['diagnostics'][number];

let findingsListener:
  | ((state: { status: 'loading' | 'loaded' | 'failed'; findings: readonly LinkFinding[] }) => void)
  | null = null;

vi.mock('../validation-audit-client', () => ({
  subscribeToDocLinkFindings: (
    _docName: string,
    cb: (state: {
      status: 'loading' | 'loaded' | 'failed';
      findings: readonly LinkFinding[];
    }) => void,
  ) => {
    findingsListener = cb;
    cb({ status: 'loading', findings: [] });
    return () => {
      findingsListener = null;
    };
  },
}));

// Imported after the mocks are registered.
const { createLocalTargetDiagnosticsExtension } = await import('./local-target-diagnostics.ts');

const DOC = 'See [the report](./missing.pdf) now.\n';

function missingFileFinding(): LinkFinding {
  const column = DOC.indexOf('[the report]');
  return {
    range: { start: { line: 0, character: column }, end: { line: 0, character: column } },
    severity: 'error',
    source: 'links',
    code: 'dead-link',
    message: 'Link target "./missing.pdf" does not resolve to an existing file.',
  } as LinkFinding;
}

let view: EditorView | null = null;

function mount(): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: DOC,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [GFM] }),
        createLocalTargetDiagnosticsExtension('doc'),
      ],
    }),
  });
}

beforeEach(() => {
  findingsListener = null;
  resetLinkValidationPolicyForTest();
});

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = '';
});

describe('source-mode local-target diagnostics wiring', () => {
  test('renders a fetched target-existence finding as a lint diagnostic', async () => {
    view = mount();
    findingsListener?.({ status: 'loaded', findings: [missingFileFinding()] });
    await vi.waitFor(() => {
      expect(view?.dom.querySelector('.cm-lint-local-target')).not.toBeNull();
    });
    // Severity survives end-to-end: an `error` finding paints the error range.
    expect(view?.dom.querySelector('.cm-lintRange-error')).not.toBeNull();
  });

  test('never mutates the authored source bytes', async () => {
    view = mount();
    findingsListener?.({ status: 'loaded', findings: [missingFileFinding()] });
    await vi.waitFor(() => {
      expect(view?.dom.querySelector('.cm-lint-local-target')).not.toBeNull();
    });
    expect(view?.state.doc.toString()).toBe(DOC);
  });

  test('heals the diagnostic after the target subscription settles present', async () => {
    view = mount();
    findingsListener?.({ status: 'loaded', findings: [missingFileFinding()] });
    await vi.waitFor(() => {
      expect(view?.dom.querySelector('.cm-lint-local-target')).not.toBeNull();
    });
    findingsListener?.({ status: 'loaded', findings: [] });
    await vi.waitFor(() => {
      expect(view?.dom.querySelector('.cm-lint-local-target')).toBeNull();
    });
    expect(view?.state.doc.toString()).toBe(DOC);
  });

  test('clears a settled diagnostic immediately when validation.links turns off', async () => {
    view = mount();
    findingsListener?.({ status: 'loaded', findings: [missingFileFinding()] });
    await vi.waitFor(() => {
      expect(view?.dom.querySelector('.cm-lint-local-target')).not.toBeNull();
    });

    setLinkValidationVisible(false);
    await vi.waitFor(() => {
      expect(view?.dom.querySelector('.cm-lint-local-target')).toBeNull();
    });
  });
});

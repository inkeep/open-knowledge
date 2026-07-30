/**
 * Unit tests for the shared validation store: full-plane replace (project
 * audit), per-doc patch (scoped re-validate), per-source live patch (open
 * doc), zero-count pruning, and subscriber notification semantics.
 */

import { beforeEach, describe, expect, test } from 'vitest';
import {
  getValidationSnapshot,
  patchDocValidationFromAudit,
  patchDocValidationSource,
  replaceValidationFromAudit,
  replaceValidationFromCounts,
  resetValidationStoreForTest,
  subscribeToValidationStore,
} from './validation-store';

const lintWarning = { severity: 'warning', source: 'markdownlint' };
const lintError = { severity: 'error', source: 'markdownlint' };
const deadLink = { severity: 'error', source: 'links' };

beforeEach(() => {
  resetValidationStoreForTest();
});

describe('validation store', () => {
  test('replaceValidationFromAudit keys totals by extension-less docName', () => {
    replaceValidationFromAudit([
      { file: 'guides/setup.md', diagnostics: [lintWarning, deadLink] },
      { file: 'notes.mdx', diagnostics: [lintError] },
    ]);
    const snapshot = getValidationSnapshot();
    expect(snapshot.get('guides/setup')).toEqual({ errorCount: 1, warningCount: 1 });
    expect(snapshot.get('notes')).toEqual({ errorCount: 1, warningCount: 0 });
  });

  test('a later replace drops healed docs from the snapshot', () => {
    replaceValidationFromAudit([{ file: 'a.md', diagnostics: [lintWarning] }]);
    replaceValidationFromAudit([{ file: 'b.md', diagnostics: [deadLink] }]);
    const snapshot = getValidationSnapshot();
    expect(snapshot.has('a')).toBe(false);
    expect(snapshot.get('b')).toEqual({ errorCount: 1, warningCount: 0 });
  });

  test('patchDocValidationFromAudit refreshes one doc; empty plane heals it', () => {
    replaceValidationFromAudit([
      { file: 'a.md', diagnostics: [lintWarning] },
      { file: 'b.md', diagnostics: [deadLink] },
    ]);
    patchDocValidationFromAudit('a', [lintError, lintWarning]);
    expect(getValidationSnapshot().get('a')).toEqual({ errorCount: 1, warningCount: 1 });
    // Other docs untouched.
    expect(getValidationSnapshot().get('b')).toEqual({ errorCount: 1, warningCount: 0 });

    patchDocValidationFromAudit('a', []);
    expect(getValidationSnapshot().has('a')).toBe(false);
  });

  test('patchDocValidationSource updates one source, preserving the other', () => {
    patchDocValidationFromAudit('a', [lintWarning, deadLink]);
    patchDocValidationSource('a', 'lint', { errorCount: 0, warningCount: 3 });
    // links error preserved; lint replaced.
    expect(getValidationSnapshot().get('a')).toEqual({ errorCount: 1, warningCount: 3 });

    patchDocValidationSource('a', 'links', { errorCount: 0, warningCount: 0 });
    expect(getValidationSnapshot().get('a')).toEqual({ errorCount: 0, warningCount: 3 });
  });

  test('subscribers fire on change and unchanged per-source patches no-op', () => {
    let notifications = 0;
    const unsubscribe = subscribeToValidationStore(() => {
      notifications += 1;
    });
    patchDocValidationSource('a', 'lint', { errorCount: 0, warningCount: 2 });
    expect(notifications).toBe(1);
    // Identical counts are a structural no-op — the tree must not re-render.
    patchDocValidationSource('a', 'lint', { errorCount: 0, warningCount: 2 });
    expect(notifications).toBe(1);
    unsubscribe();
    patchDocValidationSource('a', 'lint', { errorCount: 1, warningCount: 0 });
    expect(notifications).toBe(1);
  });

  test('all-zero docs never appear in the snapshot', () => {
    patchDocValidationSource('clean', 'lint', { errorCount: 0, warningCount: 0 });
    expect(getValidationSnapshot().has('clean')).toBe(false);
  });

  test('replaceValidationFromCounts merges per-source tallies from the counts plane', () => {
    replaceValidationFromCounts([
      {
        file: 'guides/setup.md',
        lint: { errorCount: 2, warningCount: 1 },
        links: { errorCount: 0, warningCount: 3 },
      },
      {
        file: 'clean.md',
        lint: { errorCount: 0, warningCount: 0 },
        links: { errorCount: 0, warningCount: 0 },
      },
    ]);
    const snapshot = getValidationSnapshot();
    // Keyed by extension-less docName, same as the enumerated plane.
    expect(snapshot.get('guides/setup')).toEqual({ errorCount: 2, warningCount: 4 });
    // A doc the audit reported with no problems is absent, not present-at-zero.
    expect(snapshot.has('clean.md')).toBe(false);
    expect(snapshot.has('clean')).toBe(false);
  });

  test('replaceValidationFromCounts is full-plane truth — healed docs drop out', () => {
    patchDocValidationFromAudit('gone', [lintError]);
    expect(getValidationSnapshot().has('gone')).toBe(true);

    replaceValidationFromCounts([
      {
        file: 'other.md',
        lint: { errorCount: 1, warningCount: 0 },
        links: { errorCount: 0, warningCount: 0 },
      },
    ]);
    expect(getValidationSnapshot().has('gone')).toBe(false);
    expect(getValidationSnapshot().has('other')).toBe(true);
  });

  test('the counts plane and the enumerated plane agree for the same doc', () => {
    // The two triggers must never disagree about one doc's totals; both route
    // their bucketing through the shared core predicate.
    replaceValidationFromAudit([{ file: 'a.md', diagnostics: [lintError, lintWarning, deadLink] }]);
    const fromDiagnostics = getValidationSnapshot().get('a');

    replaceValidationFromCounts([
      {
        file: 'a.md',
        lint: { errorCount: 1, warningCount: 1 },
        links: { errorCount: 1, warningCount: 0 },
      },
    ]);
    expect(getValidationSnapshot().get('a')).toEqual(fromDiagnostics);
  });
});

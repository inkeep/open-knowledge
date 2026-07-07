/**
 * EmptyEditorState — unit coverage for the `countEntries` onboarding gate.
 *
 * Repo convention: full DOM coverage lives in Playwright; this layer guards
 * the pure rule that decides whether the user sees `OnboardingView` or
 * `AgentHandoffView`. The hidden-segment rule is the load-bearing piece —
 * a refactor to `entry.docName.startsWith('.')` would miss
 * `brain/.archived/note.md` and re-introduce the false-positive that hidden
 * folders fill the empty state with infrastructure.
 */

import { describe, expect, test } from 'bun:test';
import { countEntries } from './EmptyEditorState';

describe('countEntries() — onboarding gate', () => {
  test('counts top-level documents and folders', () => {
    expect(
      countEntries([
        { kind: 'document', docName: 'INDEX' },
        { kind: 'folder', path: 'brain' },
      ]),
    ).toBe(2);
  });

  test('skips asset entries (only document + folder count)', () => {
    expect(
      countEntries([
        { kind: 'document', docName: 'INDEX' },
        { kind: 'asset', path: 'images/logo.png' },
      ]),
    ).toBe(1);
  });

  test('skips dotfile-prefixed top-level entries', () => {
    expect(
      countEntries([
        { kind: 'folder', path: '.private' },
        { kind: 'document', docName: '.config' },
      ]),
    ).toBe(0);
  });

  test('skips entries with a hidden segment at any depth', () => {
    // Matches shell `ls` semantics — anything inside a dot-prefixed parent
    // is hidden, regardless of how deep the parent sits in the tree.
    expect(
      countEntries([
        { kind: 'document', docName: 'brain/.archived/note' },
        { kind: 'folder', path: 'brain/.archived' },
      ]),
    ).toBe(0);
  });

  test('keeps non-hidden entries when hidden entries are mixed in', () => {
    expect(
      countEntries([
        { kind: 'document', docName: 'brain/index' },
        { kind: 'folder', path: '.private' },
        { kind: 'document', docName: '.config' },
        { kind: 'folder', path: 'brain' },
      ]),
    ).toBe(2);
  });

  test('returns 0 when every entry is hidden — gates onboarding view', () => {
    // The motivating scenario: user opens a project containing only
    // dotfile-prefixed folders with markdown inside. Without this rule the
    // gate would route them to `AgentHandoffView` despite no visible
    // content. With it, `OnboardingView` shows.
    expect(
      countEntries([
        { kind: 'folder', path: '.private' },
        { kind: 'document', docName: '.private/notes' },
      ]),
    ).toBe(0);
  });
});

import { describe, expect, test } from 'vitest';
import { consumeWorkspaceHashWrite, noteWorkspaceHashWrite } from './workspace-hash-writes';

describe('telling workspace hash writes from deliberate navigation', () => {
  test('a hash the workspace wrote is recognised once', () => {
    noteWorkspaceHashWrite('#/notes/today');
    expect(consumeWorkspaceHashWrite('#/notes/today')).toBe(true);
    expect(consumeWorkspaceHashWrite('#/notes/today')).toBe(false);
  });

  test('a different hash arriving after a workspace write is deliberate', () => {
    noteWorkspaceHashWrite('#/notes/today');
    expect(consumeWorkspaceHashWrite('#/notes/tomorrow')).toBe(false);
  });

  test('with no workspace write pending every hash is deliberate', () => {
    expect(consumeWorkspaceHashWrite('#/notes/today')).toBe(false);
  });
});

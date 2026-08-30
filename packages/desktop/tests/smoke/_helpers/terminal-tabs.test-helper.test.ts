import { describe, expect, test } from 'vitest';
import { findNewTerminalTabId } from './terminal-tabs.test-helper';

describe('findNewTerminalTabId', () => {
  test('identifies the created tab even when the row order changes', () => {
    expect(findNewTerminalTabId(['tab-1', 'tab-2'], ['tab-3', 'tab-1', 'tab-2'])).toBe('tab-3');
  });

  test('rejects a snapshot that does not contain exactly one new tab', () => {
    expect(() => findNewTerminalTabId(['tab-1'], ['tab-1'])).toThrow(/exactly one new tab/u);
    expect(() => findNewTerminalTabId(['tab-1'], ['tab-1', 'tab-2', 'tab-3'])).toThrow(
      /exactly one new tab/u,
    );
  });
});

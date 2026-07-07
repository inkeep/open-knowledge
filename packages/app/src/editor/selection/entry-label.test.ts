/**
 * entry-label.ts unit tests — the fallback ladder for BlockChainEntry labels
 * (shared by SelectionAnnouncer + future selection-consuming UI).
 */

import { describe, expect, test } from 'bun:test';
import type { BlockChainEntry } from '../extensions/selection-state-plugin.ts';
import { getEntryLabel } from './entry-label.ts';

const callout: BlockChainEntry = {
  bridgeId: 'b1',
  componentName: 'Callout',
  pos: 0,
};
const unregistered: BlockChainEntry = {
  bridgeId: 'b2',
  componentName: 'DataViz',
  pos: 42,
};

describe('getEntryLabel', () => {
  test('returns descriptor.displayName when registered (default)', () => {
    expect(getEntryLabel(callout)).toBe('Callout');
  });

  test('returns entry.componentName for wildcard descriptor (default)', () => {
    expect(getEntryLabel(unregistered)).toBe('DataViz');
  });

  test('appends " (unregistered)" for wildcard when unregisteredSuffix=true', () => {
    expect(getEntryLabel(unregistered, { unregisteredSuffix: true })).toBe(
      'DataViz (unregistered)',
    );
  });

  test('does NOT append suffix for registered descriptors even with unregisteredSuffix=true', () => {
    expect(getEntryLabel(callout, { unregisteredSuffix: true })).toBe('Callout');
  });
});

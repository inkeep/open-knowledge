import type { BrokenLinkSuppression } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  createReservedLogBrokenLinkSuppression,
  formatAuditBrokenLinkSuppressionLine,
  formatBrokenLinkSuppressionBrief,
  formatBrokenLinkSuppressionLine,
  formatUnreadableAuditSuppressionWarning,
} from './broken-link-suppression.ts';

describe('createReservedLogBrokenLinkSuppression', () => {
  test('constructs only positive-count observations with the canonical reason', () => {
    expect(createReservedLogBrokenLinkSuppression(2)).toEqual({
      reason: 'reserved-log-policy',
      count: 2,
    });
    expect(createReservedLogBrokenLinkSuppression(0)).toBeUndefined();
    expect(createReservedLogBrokenLinkSuppression(-1)).toBeUndefined();
  });
});

describe('formatAuditBrokenLinkSuppressionLine', () => {
  test('makes a filtered audit explicit and preserves the surface-specific raw route', () => {
    const line = formatAuditBrokenLinkSuppressionLine(
      { reason: 'reserved-log-policy', count: 2 },
      { surface: 'mcp' },
    );

    expect(line).toContain('audit result is filtered');
    expect(line).toContain('does NOT prove every link resolves');
    expect(line).toContain('Settings ▸ This project ▸ Preferences ▸ Content rules');
    expect(line).toContain('links({ kind: "dead" })');
    expect(line).toContain('not as a repair queue');
    expect(line).toContain('only when the user asks');
    expect(line).not.toContain('when you need the unfiltered view');
    expect(line).not.toContain('validation.suppressLogLinkAdvisories');
    expect(line).not.toContain('/api/dead-links');
  });

  test('does not mislabel an unknown future policy as the reserved-log policy', () => {
    const suppression = { reason: 'future-policy', count: 1 } as BrokenLinkSuppression;
    const line = formatAuditBrokenLinkSuppressionLine(suppression, { surface: 'mcp' });

    expect(line).toContain('does not recognize the project policy "future-policy"');
    expect(line).not.toContain('reserved `log.md`');
  });

  test('keeps human CLI guidance free of agent-directed instructions', () => {
    const line = formatAuditBrokenLinkSuppressionLine(
      { reason: 'reserved-log-policy', count: 2 },
      { surface: 'cli', serverBaseUrl: 'http://127.0.0.1:54321' },
    );

    expect(line).toContain('protect that history');
    expect(line).toContain('validation.suppressLogLinkAdvisories: false');
    expect(line).toContain('.ok/config.yml');
    expect(line).toContain('Settings ▸ This project ▸ Preferences ▸ Content rules');
    expect(line).toContain('http://127.0.0.1:54321/api/dead-links');
    expect(line).not.toMatch(/\/api\/dead-links\S/);
    expect(line).not.toContain('links({ kind: "dead" })');
    expect(line).toContain('when you need the unfiltered view');
    expect(line).not.toContain('the user');
    expect(line).not.toContain('point them at Settings');
  });

  test('an unknown policy has audience-correct human fallback guidance', () => {
    const suppression = { reason: 'future-policy', count: 1 } as BrokenLinkSuppression;
    const line = formatAuditBrokenLinkSuppressionLine(suppression, {
      surface: 'cli',
      serverBaseUrl: 'http://127.0.0.1:54321',
    });

    expect(line).toContain('cannot explain why these findings were withheld');
    expect(line).not.toContain('ask the user');
  });

  test('opens with its own status glyph, because it is emitted as a standalone line', () => {
    const line = formatAuditBrokenLinkSuppressionLine(
      { reason: 'reserved-log-policy', count: 1 },
      { surface: 'mcp' },
    );

    expect(line).toMatch(/^ℹ /);
  });
});

describe('formatUnreadableAuditSuppressionWarning', () => {
  test('derives the agent raw-state route and guidance rather than restating them', () => {
    const line = formatUnreadableAuditSuppressionWarning({ surface: 'mcp' });

    expect(line).toContain('in a form this build cannot read');
    expect(line).toContain('audit result is filtered');
    expect(line).toContain('does NOT prove every link resolves');
    expect(line).toContain('links({ kind: "dead" })');
    expect(line).toContain('only when the user asks');
    expect(line).toContain('not as a repair queue');
    expect(line).not.toContain('when you need the unfiltered view');
    expect(line).not.toContain('validation.suppressLogLinkAdvisories');
    expect(line).not.toContain('/api/dead-links');
  });

  test('keeps the human CLI route free of agent-directed instructions', () => {
    const line = formatUnreadableAuditSuppressionWarning({
      surface: 'cli',
      serverBaseUrl: 'http://127.0.0.1:54321',
    });

    expect(line).toContain('in a form this build cannot read');
    expect(line).toContain('http://127.0.0.1:54321/api/dead-links');
    expect(line).not.toMatch(/\/api\/dead-links\S/);
    expect(line).toContain('when you need the unfiltered view');
    expect(line).not.toContain('links({ kind: "dead" })');
    expect(line).not.toContain('the user');
  });

  test('does not claim a count it cannot read', () => {
    const line = formatUnreadableAuditSuppressionWarning({ surface: 'mcp' });

    expect(line).not.toMatch(/\d+ broken-link finding/);
    expect(line).not.toContain('undefined');
  });

  test('carries no leading status glyph, because degradationBlock supplies its own in the warnings channel', () => {
    const line = formatUnreadableAuditSuppressionWarning({ surface: 'mcp' });

    expect(line).not.toMatch(/^[ℹ⚠]/);
  });
});

describe('write and edit suppression lines', () => {
  const suppression = (count: number): BrokenLinkSuppression => ({
    reason: 'reserved-log-policy',
    count,
  });

  test('the full line reinterprets the empty list and routes the remedy to the user', () => {
    const line = formatBrokenLinkSuppressionLine(suppression(2));
    expect(line).toContain('2 broken-link findings withheld');
    expect(line).toContain('does NOT mean every link resolves');
    expect(line).toContain('Settings ▸ This project ▸ Preferences ▸ Content rules');
    expect(line).not.toContain('validation.suppressLogLinkAdvisories');
  });

  test('an unrecognized reason still says the empty list is not an all-clear', () => {
    const line = formatBrokenLinkSuppressionLine({ reason: 'some-future-policy', count: 2 });
    expect(line).toContain('2 broken-link findings withheld');
    expect(line).toContain('does NOT mean every link resolves');
    expect(line).toContain('some-future-policy');
    expect(line).toContain('not yours to repair');
  });

  test('one withheld finding reads singular', () => {
    expect(formatBrokenLinkSuppressionLine(suppression(1))).toContain('1 broken-link finding ');
    expect(formatBrokenLinkSuppressionBrief(suppression(1))).toContain('1 broken-link finding ');
  });

  test('the brief points at the structured field and states the filtered-result invariant', () => {
    const brief = formatBrokenLinkSuppressionBrief(suppression(4));
    expect(brief).toContain('4 broken-link findings withheld');
    expect(brief).toContain('brokenLinkSuppression');
    expect(brief).toContain('does NOT mean every link resolves');
    expect(brief).toContain('nothing to repair');
  });

  test('both open with their own status glyph, because no consumer supplies one', () => {
    expect(formatBrokenLinkSuppressionLine(suppression(1))).toMatch(/^ℹ /);
    expect(formatBrokenLinkSuppressionBrief(suppression(1))).toMatch(/^ℹ /);
  });
});

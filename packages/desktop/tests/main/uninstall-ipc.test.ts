import type { UninstallIntent, UninstallScreenSpec } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import {
  createUninstallScreenRegistry,
  normalizeUninstallIntent,
} from '../../src/main/uninstall-ipc.ts';

const NOTICE: UninstallScreenSpec = {
  kind: 'notice',
  notice: { title: 'Uninstall OpenKnowledge?', paragraphs: [], confirmLabel: 'Uninstall' },
};

/** Register one screen and collect whatever intents reach the flow code. */
function openScreen(screen: UninstallScreenSpec = NOTICE) {
  const registry = createUninstallScreenRegistry();
  const received: UninstallIntent[] = [];
  const release = registry.open(7, { screen, onIntent: (intent) => received.push(intent) });
  return { registry, received, release };
}

describe('uninstall screen registry — sender validation', () => {
  it('answers the window it registered with that window’s screen', () => {
    const { registry } = openScreen();
    expect(registry.dispatch(7, { kind: 'ready' })).toEqual({ kind: 'screen', screen: NOTICE });
  });

  it('refuses a window it never opened, and runs nothing for it', () => {
    const { registry, received } = openScreen();

    expect(registry.dispatch(999, { kind: 'ready' })).toEqual({
      kind: 'refused',
      reason: 'unknown-window',
    });
    expect(registry.dispatch(999, { kind: 'notice-confirm' })).toEqual({
      kind: 'refused',
      reason: 'unknown-window',
    });
    expect(received).toEqual([]);
  });

  it('stops answering a window once its screen is released', () => {
    const { registry, received, release } = openScreen();
    release();

    expect(registry.dispatch(7, { kind: 'notice-confirm' })).toEqual({
      kind: 'refused',
      reason: 'unknown-window',
    });
    expect(received).toEqual([]);
  });

  it('keeps each open window on its own screen', () => {
    const registry = createUninstallScreenRegistry();
    const picker: UninstallScreenSpec = { kind: 'picker', projects: [] };
    registry.open(1, { screen: NOTICE, onIntent: () => {} });
    registry.open(2, { screen: picker, onIntent: () => {} });

    expect(registry.dispatch(1, { kind: 'ready' })).toEqual({ kind: 'screen', screen: NOTICE });
    expect(registry.dispatch(2, { kind: 'ready' })).toEqual({ kind: 'screen', screen: picker });
  });
});

describe('uninstall screen registry — intent delivery', () => {
  it('delivers each recognized intent once', () => {
    const { registry, received } = openScreen();

    expect(registry.dispatch(7, { kind: 'picker-cancel' })).toEqual({ kind: 'accepted' });
    expect(registry.dispatch(7, { kind: 'survey-skip' })).toEqual({ kind: 'accepted' });
    expect(registry.dispatch(7, { kind: 'notice-reveal-log' })).toEqual({ kind: 'accepted' });

    expect(received).toEqual([
      { kind: 'picker-cancel' },
      { kind: 'survey-skip' },
      { kind: 'notice-reveal-log' },
    ]);
  });

  it('delivers the two notice intents unswapped', () => {
    // notice-confirm and notice-cancel resolve completion opposite ways, and the
    // window is destroyed either way (no user feedback). A `case 'notice-confirm':
    // return { kind: 'notice-cancel' }` swap is TypeScript-undetectable, so pin
    // that each arrives as itself.
    const { registry, received } = openScreen();

    expect(registry.dispatch(7, { kind: 'notice-confirm' })).toEqual({ kind: 'accepted' });
    expect(registry.dispatch(7, { kind: 'notice-cancel' })).toEqual({ kind: 'accepted' });

    expect(received).toEqual([{ kind: 'notice-confirm' }, { kind: 'notice-cancel' }]);
  });

  it('refuses an unrecognized payload without running the flow', () => {
    const { registry, received } = openScreen();

    for (const payload of [
      { kind: 'delete-everything' },
      { kind: 42 },
      'notice-confirm',
      null,
      undefined,
      [],
    ]) {
      expect(registry.dispatch(7, payload)).toEqual({ kind: 'refused', reason: 'invalid-intent' });
    }
    expect(received).toEqual([]);
  });
});

describe('normalizeUninstallIntent — payload containment', () => {
  it('keeps only the fields the intent declares, so no path can ride along', () => {
    const intent = normalizeUninstallIntent({
      kind: 'picker-confirm',
      selectedIndexes: [0],
      projectPaths: ['/'],
      appBundlePath: '/tmp/evil.app',
      logPath: '/etc/passwd',
    });

    expect(intent).toEqual({ kind: 'picker-confirm', selectedIndexes: [0] });
    expect(JSON.stringify(intent)).not.toContain('/tmp/evil.app');
  });

  it('drops selection entries that cannot index a list', () => {
    expect(
      normalizeUninstallIntent({
        kind: 'picker-confirm',
        selectedIndexes: ['0', 1.5, Number.NaN, null, { valueOf: () => 3 }, 2],
      }),
    ).toEqual({ kind: 'picker-confirm', selectedIndexes: [2] });
  });

  it('treats a non-array selection as no selection', () => {
    expect(normalizeUninstallIntent({ kind: 'picker-confirm', selectedIndexes: '0,1,2' })).toEqual({
      kind: 'picker-confirm',
      selectedIndexes: [],
    });
  });

  it('trims survey answers, drops blanks, and rejects an off-taxonomy reason', () => {
    expect(
      normalizeUninstallIntent({
        kind: 'survey-send',
        reason: 'not-a-real-reason',
        note: '  it was fine  ',
        email: '   ',
      }),
    ).toEqual({ kind: 'survey-send', note: 'it was fine' });
  });

  it('keeps a reason that is in the taxonomy', () => {
    expect(normalizeUninstallIntent({ kind: 'survey-send', reason: 'missing-feature' })).toEqual({
      kind: 'survey-send',
      reason: 'missing-feature',
    });
  });

  it('ignores survey answers that are not strings', () => {
    expect(
      normalizeUninstallIntent({ kind: 'survey-send', note: { toString: () => 'x' }, email: 12 }),
    ).toEqual({ kind: 'survey-send' });
  });

  it('clamps survey answers to the intake’s field limits', () => {
    const intent = normalizeUninstallIntent({
      kind: 'survey-send',
      note: 'n'.repeat(20_000),
      email: `${'e'.repeat(400)}@example.com`,
    });

    expect(intent).toMatchObject({ kind: 'survey-send' });
    expect(intent?.kind === 'survey-send' && intent.note?.length).toBe(10_000);
    expect(intent?.kind === 'survey-send' && intent.email?.length).toBe(320);
  });
});

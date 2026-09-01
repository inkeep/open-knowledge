/**
 * Pre-implementation gate tests for the Pierre conflict-view migration (Q15).
 *
 * These tests prove two things that locked design decisions assumed but no
 * prior spike measured against a diff3 fixture:
 *   1. Pierre renders the full diff3 row set — including marker-base — under
 *      the repo's jsdom tier.
 *   2. `instance.render({ ...snapshot, forceRender: true })` reuses the same
 *      `<diffs-container>` element and shadow root with no remount.
 *
 * If either test fails, record which locked decision is invalidated before
 * proceeding. See SPEC §16 STOP_IF and evidence/undo-spike.md.
 */

import { UnresolvedFile } from '@pierre/diffs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DIFF3_FIXTURE, pierreShadow } from './pierre-conflict.test-helper';

describe('Pierre diff3 pre-implementation gate', () => {
  let host: HTMLDivElement;
  let inst: UnresolvedFile | null = null;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    inst?.cleanUp();
    host.remove();
    inst = null;
  });

  test('diff3 fixture renders the full ordered row set including marker-base', async () => {
    inst = new UnresolvedFile({ onMergeConflictAction: () => {} });
    inst.render({ file: { name: 'test.md', contents: DIFF3_FIXTURE }, containerWrapper: host });

    // Pierre finishes its render across queued tasks; wait a macrotask so the
    // chain drains before asserting row presence.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const shadow = pierreShadow(host);
    const rows = Array.from(shadow.querySelectorAll('[data-merge-conflict]'));
    const types = rows.map((r) => r.getAttribute('data-merge-conflict'));

    expect(types).toContain('marker-start');
    expect(types).toContain('current');
    expect(types).toContain('marker-base');
    expect(types).toContain('marker-separator');
    expect(types).toContain('incoming');
    expect(types).toContain('marker-end');

    // Pierre renders a split-preview row (current | incoming side-by-side) BEFORE
    // the raw marker section. So 'current' and 'incoming' each appear twice:
    //   [current, incoming, marker-start, current, marker-base, marker-separator, incoming, marker-end]
    // Use lastIndexOf for content types to anchor to the source/marker section.
    const startIdx = types.indexOf('marker-start');
    const currentIdx = types.lastIndexOf('current');
    const baseIdx = types.indexOf('marker-base');
    const sepIdx = types.indexOf('marker-separator');
    const incomingIdx = types.lastIndexOf('incoming');
    const endIdx = types.indexOf('marker-end');

    expect(startIdx).toBeLessThan(currentIdx);
    expect(currentIdx).toBeLessThan(baseIdx);
    expect(baseIdx).toBeLessThan(sepIdx);
    expect(sepIdx).toBeLessThan(incomingIdx);
    expect(incomingIdx).toBeLessThan(endIdx);
  });

  test('render with forceRender reuses the same diffs-container element and shadow root (no remount)', async () => {
    type ResolveReturn = NonNullable<ReturnType<UnresolvedFile['resolveConflict']>>;
    let captured: ResolveReturn | null = null;

    inst = new UnresolvedFile({
      onMergeConflictAction: (payload) => {
        captured =
          inst?.resolveConflict(payload.conflict.conflictIndex, payload.resolution) ?? null;
      },
    });
    inst.render({ file: { name: 'test.md', contents: DIFF3_FIXTURE }, containerWrapper: host });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const diffsEl = host.querySelector('diffs-container');
    const shadowBefore = diffsEl?.shadowRoot;
    expect(diffsEl).not.toBeNull();
    expect(shadowBefore).not.toBeNull();

    // Click a default shadow-DOM action button — composedPath() delegation works in jsdom
    const shadow = pierreShadow(host);
    const actionBtn = shadow.querySelector('[data-merge-conflict-action="current"]');
    expect(actionBtn).not.toBeNull();
    actionBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(captured).not.toBeNull();
    // Guard for TypeScript narrowing — expect above ensures non-null.
    if (!captured) return;

    // Apply the resolved state — must not remount the element
    inst.render({ ...captured, forceRender: true });

    expect(host.querySelector('diffs-container')).toBe(diffsEl);
    expect(host.querySelector('diffs-container')?.shadowRoot).toBe(shadowBefore);
  });
});

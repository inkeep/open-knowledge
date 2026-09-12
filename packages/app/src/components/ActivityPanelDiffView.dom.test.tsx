// @vitest-environment jsdom

import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { pierreShadow } from '@/test-utils/pierre-shadow';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

const { ActivityPanelDiffView } = await import('./ActivityPanelDiffView');

const SIMPLE_BEFORE = 'line one\nline two\noriginal line\nline four\nline five\n';
const SIMPLE_AFTER = 'line one\nline two\nchanged line\nline four\nline five\n';

const FILL = 'lorem ipsum dolor sit amet consectetur '.repeat(36);
const LONG_LINE_BEFORE = `${FILL}originalword${FILL}\n`;
const LONG_LINE_AFTER = `${FILL}changedword${FILL}\n`;

async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  cleanup();
});

describe('ActivityPanelDiffView — No changes branches', () => {
  test('renders the No changes placeholder when before equals after', async () => {
    const { container } = render(
      <ActivityPanelDiffView before="same content\n" after="same content\n" cacheKey="doc@v1" />,
    );
    await settle();
    expect(container.textContent).toContain('No changes');
    expect(container.querySelector('diffs-container')).toBeNull();
  });

  test('renders the No changes placeholder for empty strings', async () => {
    const { container } = render(<ActivityPanelDiffView before="" after="" cacheKey="doc@v1" />);
    await settle();
    expect(container.textContent).toContain('No changes');
    expect(container.querySelector('diffs-container')).toBeNull();
  });

  test('keeps the activity-panel-diff wrapper on the placeholder', async () => {
    const { container } = render(
      <ActivityPanelDiffView before="x\n" after="x\n" cacheKey="doc@v1" />,
    );
    await settle();
    expect(container.querySelector('.activity-panel-diff')).not.toBeNull();
  });
});

describe('ActivityPanelDiffView — shadow root contract', () => {
  test('mounts a diffs-container with an open shadow root for changed before/after', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={SIMPLE_BEFORE} after={SIMPLE_AFTER} cacheKey="doc@v1" />,
    );
    const shadow = await pierreShadow(container);
    expect(shadow).not.toBeNull();
    expect(shadow.host).toBe(container.querySelector('diffs-container'));
  });

  test('wraps the Pierre renderer in the activity-panel-diff div', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={SIMPLE_BEFORE} after={SIMPLE_AFTER} cacheKey="doc@v1" />,
    );
    await settle();
    await settle();
    expect(container.querySelector('.activity-panel-diff')).not.toBeNull();
  });

  test('mounts Pierre without error on unusual string content', async () => {
    const { container } = render(
      <ActivityPanelDiffView
        before="---\n!!!\n@@@\n"
        after="different content\n"
        cacheKey="doc@v1"
      />,
    );
    await pierreShadow(container);
  });

  test('renders with overflow:wrap — data-overflow attribute present in shadow root', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={SIMPLE_BEFORE} after={SIMPLE_AFTER} cacheKey="doc@v1" />,
    );
    const shadow = await pierreShadow(container);
    expect(shadow.querySelector('pre[data-overflow="wrap"]')).not.toBeNull();
  });
});

describe('ActivityPanelDiffView — data-line-type canary', () => {
  test('a known fixture yields at least one change-addition and change-deletion row', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={SIMPLE_BEFORE} after={SIMPLE_AFTER} cacheKey="doc@v1" />,
    );
    const root = await pierreShadow(container);
    expect(root.querySelector('[data-line-type="change-addition"]')).not.toBeNull();
    expect(root.querySelector('[data-line-type="change-deletion"]')).not.toBeNull();
  });
});

describe('ActivityPanelDiffView — whole-file context (no hunk separator)', () => {
  test('parseDiffOptions.context renders all lines without a separator for a multi-line document', async () => {
    const head = 'changed line\n';
    const middle = Array.from({ length: 18 }, (_, i) => `context line ${i + 1}\n`).join('');
    const tail = 'another changed\n';
    const before = `${head}${middle}unchanged tail\n`;
    const after = `${head.replace('changed', 'modified')}${middle}${tail}`;
    const { container } = render(
      <ActivityPanelDiffView before={before} after={after} cacheKey="doc@v1" />,
    );
    const shadow = await pierreShadow(container);
    expect(shadow.textContent).toContain('context line 18');
    expect(shadow.textContent).not.toContain('unmodified lines');
  });
});

describe('ActivityPanelDiffView — maxLineDiffLength', () => {
  test('a long-line fixture with one changed word produces data-diff-span in [data-content]', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={LONG_LINE_BEFORE} after={LONG_LINE_AFTER} cacheKey="doc@v1" />,
    );
    const shadow = await pierreShadow(container);
    await waitFor(() =>
      expect(shadow.querySelectorAll('[data-content] [data-diff-span]').length).toBeGreaterThan(0),
    );
  });
});

describe('ActivityPanelDiffView — axe accessibility', () => {
  test('mounted Pierre pane has no WCAG violations in jsdom', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={SIMPLE_BEFORE} after={SIMPLE_AFTER} cacheKey="doc@v1" />,
    );
    await pierreShadow(container);
    const results = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    expect(results.violations).toEqual([]);
  });
});

describe('ActivityPanelDiffView — Pierre option contract', () => {
  test('renders with classic indicators and no Pierre file header', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={SIMPLE_BEFORE} after={SIMPLE_AFTER} cacheKey="doc@v1" />,
    );
    const root = await pierreShadow(container);
    expect(root.querySelector('pre[data-indicators="classic"]')).not.toBeNull();
    expect(root.querySelector('[data-diffs-header]')).toBeNull();
  });

  test('renders unified (single-column), never split', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={SIMPLE_BEFORE} after={SIMPLE_AFTER} cacheKey="doc@v1" />,
    );
    const shadow = await pierreShadow(container);
    expect(shadow.querySelector('pre[data-diff-type="single"]')).not.toBeNull();
  });

  test('applies the OK theme — shadow :host maps Pierre tokens onto app tokens', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={SIMPLE_BEFORE} after={SIMPLE_AFTER} cacheKey="doc@v1" />,
    );
    const shadow = await pierreShadow(container);
    const css = Array.from(shadow.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n');
    expect(css).toContain('--diffs-fg:var(--foreground)');
    expect(css).toContain('--diffs-bg:var(--background)');
  });
});

describe('ActivityPanelDiffView — gutter aria-hidden injection', () => {
  test('gutter rows carry aria-hidden="true" after Pierre settles', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={SIMPLE_BEFORE} after={SIMPLE_AFTER} cacheKey="doc@v1" />,
    );
    const shadow = await pierreShadow(container);
    const allLineTypeEls = Array.from(shadow.querySelectorAll('[data-line-type]'));
    const gutterRows = allLineTypeEls.filter((el) => !el.closest('[data-content]'));
    expect(gutterRows.length).toBeGreaterThan(0);
    for (const row of gutterRows) {
      expect(row.getAttribute('aria-hidden')).toBe('true');
    }
  });

  test('glyph-override style element is injected into the shadow root', async () => {
    const { container } = render(
      <ActivityPanelDiffView before={SIMPLE_BEFORE} after={SIMPLE_AFTER} cacheKey="doc@v1" />,
    );
    const shadow = await pierreShadow(container);
    expect(shadow.querySelector('[data-ok-glyph-override]')).not.toBeNull();
  });
});

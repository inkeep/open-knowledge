// @vitest-environment jsdom

import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const { ConflictView } = await import('./ConflictView');

const OUR_CONTENT = 'Our version of the line.\n';
const BASE_CONTENT = 'Original line.\n';
const THEIR_CONTENT = 'Their version of the line.\n';

async function renderConflictView(onResolve = vi.fn()) {
  render(
    <ConflictView
      fileName="notes/sync-engine.md"
      ours={OUR_CONTENT}
      base={BASE_CONTENT}
      theirs={THEIR_CONTENT}
      onResolve={onResolve}
    />,
  );
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  return onResolve;
}

async function resolveWith(btnName: string, onResolve = vi.fn()) {
  await renderConflictView(onResolve);
  screen.getByRole('button', { name: new RegExp(`^${btnName}`) }).click();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  screen.getByRole('button', { name: 'Apply changes' }).click();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  return onResolve;
}

describe('ConflictView', () => {
  afterEach(() => {
    cleanup();
  });

  test('the file header shows the real document name', async () => {
    await renderConflictView();

    const root = document.querySelector('diffs-container')?.shadowRoot;
    expect(root?.textContent).toContain('sync-engine.md');
    expect(root?.textContent).not.toContain('conflict.md');
  });

  test('base section is hidden by default', async () => {
    await renderConflictView();

    const root = document.querySelector('diffs-container')?.shadowRoot;
    expect(root?.querySelector('[data-merge-conflict="marker-base"]')).toBeNull();
  });

  test('Show original reveals the base section', async () => {
    await renderConflictView();

    screen.getByRole('button', { name: 'Show original' }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    const root = document.querySelector('diffs-container')?.shadowRoot;
    expect(root?.querySelector('[data-merge-conflict="marker-base"]')).not.toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show original' });
    expect(toggle.textContent).toBe('Hide original');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  test('conflict bodies wrap instead of scrolling horizontally', async () => {
    await renderConflictView();

    const diffs = document.querySelector('diffs-container');
    const root = diffs?.shadowRoot;
    expect(root).toBeTruthy();

    const overflowed = root?.querySelector('[data-overflow]');
    expect(overflowed?.getAttribute('data-overflow')).toBe('wrap');
  });

  test('resolution buttons land in the document light DOM, not in a shadow root', async () => {
    await renderConflictView();

    const btn = screen.getByRole('button', { name: /^Accept current/ });
    expect(btn.getRootNode()).toBe(document);
  });

  test('clicking Accept current fires onResolve with conflict-marker-free content', async () => {
    const onResolve = vi.fn();
    await renderConflictView(onResolve);

    const btn = screen.getByRole('button', { name: /^Accept current/ });
    btn.click();

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    screen.getByRole('button', { name: 'Apply changes' }).click();

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(onResolve).toHaveBeenCalledOnce();
    const resolved = onResolve.mock.calls[0][0] as string;
    expect(resolved).not.toContain('<<<<<<<');
    expect(resolved).toContain('Our version');
  });
  test('Pierre paints from the app theme, not its bundled palette', async () => {
    await renderConflictView();

    const root = document.querySelector('diffs-container')?.shadowRoot;
    const themeCSS = Array.from(root?.querySelectorAll('style') ?? [])
      .map((node) => node.textContent ?? '')
      .join('');

    expect(themeCSS).toContain('--diffs-fg:var(--foreground)');
    expect(themeCSS).toContain('--diffs-bg:var(--background)');
    expect(themeCSS).not.toContain('--diffs-light');
    expect(themeCSS).not.toContain('--diffs-dark');
    expect(themeCSS).not.toContain('--diffs-addition-color');
    expect(themeCSS).not.toContain('--diffs-modified-color');
    expect(themeCSS).not.toContain('--diffs-deletion-color');
  });
});

describe('ConflictView resolution sweep — byte-exact readback', () => {
  afterEach(() => {
    cleanup();
  });

  test('current resolution reproduces ours byte-exactly', async () => {
    const onResolve = await resolveWith('Accept current');
    expect(onResolve).toHaveBeenCalledOnce();
    expect(onResolve.mock.calls[0][0]).toBe(OUR_CONTENT);
  });

  test('incoming resolution reproduces theirs byte-exactly', async () => {
    const onResolve = await resolveWith('Accept incoming');
    expect(onResolve).toHaveBeenCalledOnce();
    expect(onResolve.mock.calls[0][0]).toBe(THEIR_CONTENT);
  });

  test('both resolution concatenates ours and theirs without a separator', async () => {
    const onResolve = await resolveWith('Accept both');
    const resolved = onResolve.mock.calls[0][0] as string;
    expect(resolved).toBe(`${OUR_CONTENT}${THEIR_CONTENT}`);
  });

  test('base section absent from every resolved output', async () => {
    for (const btnName of ['Accept current', 'Accept incoming', 'Accept both'] as const) {
      cleanup();
      const onResolve = await resolveWith(btnName);
      const resolved = onResolve.mock.calls[0][0] as string;
      expect(resolved).not.toContain('|||||||');
      expect(resolved).not.toContain(BASE_CONTENT.trim());
    }
  });

  test('base section absent from every resolved output WITH the base shown', async () => {
    for (const btnName of ['Accept current', 'Accept incoming', 'Accept both'] as const) {
      cleanup();
      const onResolve = vi.fn();
      await renderConflictView(onResolve);

      screen.getByRole('button', { name: 'Show original' }).click();
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      screen.getByRole('button', { name: new RegExp(`^${btnName}`) }).click();
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      screen.getByRole('button', { name: 'Apply changes' }).click();
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      const resolved = onResolve.mock.calls[0][0] as string;
      expect(resolved).not.toContain('|||||||');
      expect(resolved).not.toContain('<<<<<<<');
      expect(resolved).not.toContain('=======');
      expect(resolved).not.toContain('>>>>>>>');
      expect(resolved).not.toContain(BASE_CONTENT.trim());
    }
  });

  test('CRLF line endings preserved through current resolution', async () => {
    const oursCrlf = 'Our CRLF line.\r\n';
    const baseCrlf = 'Original.\r\n';
    const theirsCrlf = 'Their CRLF line.\r\n';
    const onResolve = vi.fn();
    render(
      <ConflictView ours={oursCrlf} base={baseCrlf} theirs={theirsCrlf} onResolve={onResolve} />,
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    screen.getByRole('button', { name: /^Accept current/ }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    screen.getByRole('button', { name: 'Apply changes' }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(onResolve.mock.calls[0][0]).toBe(oursCrlf);
  });

  test('CRLF line endings preserved through incoming resolution', async () => {
    const oursCrlf = 'Our CRLF line.\r\n';
    const baseCrlf = 'Original.\r\n';
    const theirsCrlf = 'Their CRLF line.\r\n';
    const onResolve = vi.fn();
    render(
      <ConflictView ours={oursCrlf} base={baseCrlf} theirs={theirsCrlf} onResolve={onResolve} />,
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    screen.getByRole('button', { name: /^Accept incoming/ }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    screen.getByRole('button', { name: 'Apply changes' }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(onResolve.mock.calls[0][0]).toBe(theirsCrlf);
  });

  test('leading tabs and trailing spaces survive current resolution', async () => {
    const oursTabbed = '\tindented line   \n';
    const baseTabbed = '\toriginal   \n';
    const theirsTabbed = '\ttheirs   \n';
    const onResolve = vi.fn();
    render(
      <ConflictView
        fileName="notes/sync-engine.md"
        ours={oursTabbed}
        base={baseTabbed}
        theirs={theirsTabbed}
        onResolve={onResolve}
      />,
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    screen.getByRole('button', { name: /^Accept current/ }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    screen.getByRole('button', { name: 'Apply changes' }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(onResolve.mock.calls[0][0]).toBe(oursTabbed);
  });

  test('2-way (null base) current resolution reproduces ours byte-exactly', async () => {
    const onResolve = vi.fn();
    render(
      <ConflictView ours={OUR_CONTENT} base="" theirs={THEIR_CONTENT} onResolve={onResolve} />,
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    screen.getByRole('button', { name: /^Accept current/ }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    screen.getByRole('button', { name: 'Apply changes' }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(onResolve.mock.calls[0][0]).toBe(OUR_CONTENT);
  });

  test('both button is available and not suppressed for prose content', async () => {
    await renderConflictView();
    expect(screen.getByRole('button', { name: /^Accept both/ })).not.toBeNull();
  });

  test('preamble and postamble pass through both-modified resolution unchanged', async () => {
    const preamble = '# Header\n\n';
    const postamble = '\nFooter paragraph.\n';
    const ours = `${preamble}Our paragraph.\n${postamble}`;
    const base = `${preamble}Original paragraph.\n${postamble}`;
    const theirs = `${preamble}Their paragraph.\n${postamble}`;
    const onResolve = vi.fn();
    render(<ConflictView ours={ours} base={base} theirs={theirs} onResolve={onResolve} />);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    screen.getByRole('button', { name: /^Accept current/ }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    screen.getByRole('button', { name: 'Apply changes' }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const resolved = onResolve.mock.calls[0][0] as string;
    expect(resolved).toContain('# Header');
    expect(resolved).toContain('Our paragraph.');
    expect(resolved).toContain('Footer paragraph.');
    expect(resolved).not.toContain('Their paragraph.');
  });
});

describe('ConflictView focus management (US-009)', () => {
  afterEach(() => {
    cleanup();
  });

  test('focus is not on body after a resolution is applied', async () => {
    await renderConflictView();
    screen.getByRole('button', { name: /^Accept current/ }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).not.toBe(document.body);
  });

  test('focus is not on body after a resolution is undone', async () => {
    await renderConflictView();
    screen.getByRole('button', { name: /^Accept current/ }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    screen.getByRole('button', { name: 'Undo' }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe('ConflictView absent-stage banners — one fixture per kind', () => {
  afterEach(() => {
    cleanup();
  });

  test('delete-modify (empty ours) shows the deleted-on-current-branch banner', async () => {
    render(
      <ConflictView
        fileName="notes/sync-engine.md"
        ours=""
        base="Original shared content.\n"
        theirs="Upstream modification.\n"
        onResolve={vi.fn()}
      />,
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const banner = document.body.querySelector('p');
    expect(banner?.textContent).toContain('current branch');
  });

  test('modify-delete (empty theirs) shows the deleted-on-incoming-branch banner', async () => {
    render(
      <ConflictView
        fileName="notes/sync-engine.md"
        ours="Local modification.\n"
        base="Original shared content.\n"
        theirs=""
        onResolve={vi.fn()}
      />,
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const banner = document.body.querySelector('p');
    expect(banner?.textContent).toContain('incoming branch');
  });

  test('add/add (empty base) shows the no-common-ancestor banner', async () => {
    render(
      <ConflictView
        fileName="notes/sync-engine.md"
        ours="Content added on current branch.\n"
        base=""
        theirs="Content added on incoming branch.\n"
        onResolve={vi.fn()}
      />,
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const banner = document.body.querySelector('p');
    expect(banner?.textContent).toContain('No common ancestor');
  });
});

describe('ConflictView axe accessibility scan', () => {
  afterEach(() => {
    cleanup();
  });

  test('conflict surface has no detectable WCAG violations', async () => {
    render(
      <ConflictView
        fileName="notes/sync-engine.md"
        ours={OUR_CONTENT}
        base={BASE_CONTENT}
        theirs={THEIR_CONTENT}
        onResolve={vi.fn()}
      />,
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const results = await axe.run(document.body, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    expect(results.violations).toEqual([]);
  });
});

describe('ConflictView — controls after undo', () => {
  const TWO_BASE = '# Pricing\n\nLine A base.\n\nShared context line.\n\nLine B base.\n';
  const TWO_OURS = '# Pricing\n\nLine A ours.\n\nShared context line.\n\nLine B ours.\n';
  const TWO_THEIRS = '# Pricing\n\nLine A theirs.\n\nShared context line.\n\nLine B theirs.\n';

  async function renderTwo() {
    render(
      <ConflictView
        fileName="notes/pricing.md"
        ours={TWO_OURS}
        base={TWO_BASE}
        theirs={TWO_THEIRS}
        onResolve={vi.fn()}
      />,
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  const rows = () => screen.queryAllByRole('button', { name: /^Accept current/ }).length;

  test('every unresolved conflict keeps its controls after an undo', async () => {
    await renderTwo();
    expect(rows()).toBe(2);

    const before = screen.getAllByRole('button', { name: /^Accept current/ });
    before[before.length - 1].click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(rows()).toBe(1);

    screen.getByRole('button', { name: 'Undo' }).click();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(rows()).toBe(2);
  });
});

describe('ConflictView — word-level highlighting inside conflicts', () => {
  const pad = (n: number) => 'filler '.repeat(n);
  const doc = (tier: string, n: number) => `# P\n\n${pad(n)}The ${tier} tier ships in Q4.\n`;

  async function spanCount(n: number, showBase: boolean) {
    const { container } = render(
      <ConflictView
        fileName="notes/pricing.md"
        ours={doc('Team', n)}
        base={doc('Base', n)}
        theirs={doc('Pro', n)}
        onResolve={vi.fn()}
      />,
    );
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    if (showBase) {
      screen.getByRole('button', { name: 'Show original' }).click();
      await act(async () => {
        await new Promise<void>((r) => setTimeout(r, 0));
      });
    }
    const root = container.querySelector('diffs-container')?.shadowRoot;
    return root?.querySelectorAll('[data-diff-span]').length ?? 0;
  }

  test('marks the differing words on a short line', async () => {
    expect(await spanCount(2, false)).toBeGreaterThan(0);
  });

  test('those spans are actually styled, not just present', async () => {
    const { container } = render(
      <ConflictView
        fileName="notes/pricing.md"
        ours={doc('Team', 2)}
        base={doc('Base', 2)}
        theirs={doc('Pro', 2)}
        onResolve={vi.fn()}
      />,
    );
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    const root = container.querySelector('diffs-container')?.shadowRoot;
    const spans = [...(root?.querySelectorAll('[data-diff-span]') ?? [])];
    expect(spans.length).toBeGreaterThan(0);

    for (const span of spans) {
      expect(span.closest('[data-merge-conflict]')).not.toBeNull();
    }
    const css = [
      ...[...(root?.querySelectorAll('style') ?? [])].map((n) => n.textContent ?? ''),
      ...[...(root?.adoptedStyleSheets ?? [])].flatMap((sheet) =>
        [...sheet.cssRules].map((r) => r.cssText),
      ),
    ].join(' ');
    expect(css).toMatch(/\[data-merge-conflict="current"\]\s*\[data-diff-span\]/);
    expect(css).toMatch(/\[data-merge-conflict="incoming"\]\s*\[data-diff-span\]/);
    expect(css).toMatch(/\[data-diff-span\]\s*\+\s*\[data-diff-span\]/);
  });

  test("gives up past Pierre's 1000-char line cap", async () => {
    expect(await spanCount(350, false)).toBe(0);
  });

  test('is off while the base section is shown', async () => {
    expect(await spanCount(2, true)).toBe(0);
  });
});

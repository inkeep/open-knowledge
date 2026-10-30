import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { screen } from '@testing-library/react';
import { type ReactElement, useState } from 'react';
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import {
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderWithI18n } from '../../../tests/foundation/render-with-i18n.test-helper';
import { ThreadHistoryPanel, ThreadHistorySearchProvider } from './ThreadHistoryPanel';

type Bounds = Pick<DOMRectReadOnly, 'top' | 'right' | 'bottom' | 'left'>;
type Paint = ReturnType<typeof readPaint>;
type PaintBoundary = { bounds: Bounds; clipX: boolean; clipY: boolean };

let stylesheet: HTMLStyleElement;

beforeAll(async () => {
  stylesheet = document.createElement('style');
  stylesheet.textContent = await commands.buildAppStylesheet();
  document.head.append(stylesheet);
});

afterAll(() => stylesheet.remove());

function readPaint(element: Element) {
  const style = getComputedStyle(element);
  return {
    shadow: style.boxShadow,
    outline: [style.outlineStyle, style.outlineWidth, style.outlineOffset, style.outlineColor].join(
      ' ',
    ),
  };
}

function ancestors(element: Element): Element[] {
  const elements: Element[] = [];
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    elements.push(current);
  }
  return elements;
}

function hasInk(color: string): boolean {
  const context = new OffscreenCanvas(1, 1).getContext('2d');
  if (context === null) throw new Error('The browser did not supply a color reader');
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data.some((value, index) => index === 3 && value > 0);
}

function shadowBounds(element: Element, shadow: string): Bounds[] {
  if (shadow === 'none') return [];
  const rect = element.getBoundingClientRect();
  return shadow.split(/,(?![^()]*\))/).flatMap((layer) => {
    const color = layer
      .replace(/-?(?:\d*\.)?\d+px/g, '')
      .replace(/\binset\b/g, '')
      .trim();
    if (!hasInk(color)) return [];
    if (layer.includes('inset')) return [rect];
    const [x = 0, y = 0, blur = 0, spread = 0] = Array.from(
      layer.matchAll(/(-?(?:\d*\.)?\d+)px/g),
      (match) => Number(match[1]),
    );
    const extent = Math.max(0, spread + blur);
    return [
      {
        left: rect.left + x - extent,
        right: rect.right + x + extent,
        top: rect.top + y - extent,
        bottom: rect.bottom + y + extent,
      },
    ];
  });
}

function focusBounds(element: Element, before: Paint): Bounds[] {
  const style = getComputedStyle(element);
  const current = readPaint(element);
  const bounds = current.shadow === before.shadow ? [] : shadowBounds(element, current.shadow);
  if (
    current.outline !== before.outline &&
    style.outlineStyle !== 'none' &&
    style.outlineStyle !== 'hidden' &&
    Number.parseFloat(style.outlineWidth) > 0 &&
    hasInk(style.outlineColor)
  ) {
    const rect = element.getBoundingClientRect();
    const extent = Math.max(
      0,
      Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset),
    );
    bounds.push({
      left: rect.left - extent,
      right: rect.right + extent,
      top: rect.top - extent,
      bottom: rect.bottom + extent,
    });
  }
  return bounds;
}

function paintBoundary(element: Element): PaintBoundary | null {
  const style = getComputedStyle(element);
  const containsPaint =
    style.contentVisibility !== 'visible' ||
    style.contain.split(' ').some((value) => ['paint', 'strict', 'content'].includes(value));
  const clipX = containsPaint || style.overflowX !== 'visible';
  const clipY = containsPaint || style.overflowY !== 'visible';
  if (!clipX && !clipY) return null;
  const rect = element.getBoundingClientRect();
  const clipMargin = style.overflowClipMargin.split(' ');
  const marginLength = clipMargin.find((value) => value.endsWith('px'));
  const margin = marginLength === undefined ? 0 : Number.parseFloat(marginLength);
  const borderBox = clipMargin.includes('border-box');
  const contentBox = clipMargin.includes('content-box');
  const inset = (side: string, overflow: string) => {
    const clipsAtPadding = !['visible', 'clip'].includes(overflow);
    return (
      (borderBox && !clipsAtPadding
        ? 0
        : Number.parseFloat(style.getPropertyValue(`border-${side}-width`))) +
      (contentBox && !clipsAtPadding
        ? Number.parseFloat(style.getPropertyValue(`padding-${side}`))
        : 0) -
      (clipsAtPadding ? 0 : margin)
    );
  };
  return {
    bounds: {
      left: rect.left + inset('left', style.overflowX),
      right: rect.right - inset('right', style.overflowX),
      top: rect.top + inset('top', style.overflowY),
      bottom: rect.bottom - inset('bottom', style.overflowY),
    },
    clipX,
    clipY,
  };
}

function clippedEdges(ink: Bounds, { bounds, clipX, clipY }: PaintBoundary): string[] {
  return [
    ...(clipX && ink.left < bounds.left ? ['left'] : []),
    ...(clipX && ink.right > bounds.right ? ['right'] : []),
    ...(clipY && ink.top < bounds.top ? ['top'] : []),
    ...(clipY && ink.bottom > bounds.bottom ? ['bottom'] : []),
  ];
}

function mount(children: ReactElement) {
  const root = document.documentElement;
  const dark = root.classList.contains('dark');
  const colorTheme = root.getAttribute('data-color-theme');
  const colorScheme = root.style.colorScheme;
  onTestFinished(() => {
    root.classList.toggle('dark', dark);
    if (colorTheme === null) root.removeAttribute('data-color-theme');
    else root.setAttribute('data-color-theme', colorTheme);
    root.style.colorScheme = colorScheme;
  });
  root.classList.remove('dark');
  root.removeAttribute('data-color-theme');
  root.style.colorScheme = 'light';
  renderWithI18n(
    <TooltipProvider>
      <div tabIndex={-1} data-testid="history-focus-start" />
      <div
        className="h-80 w-64 bg-sidebar p-4 text-sidebar-foreground"
        data-testid="history-focus-surface"
      >
        {children}
      </div>
    </TooltipProvider>,
  );
  screen.getByTestId('history-focus-start').focus();
}

async function expectUnclippedFocus(target: HTMLElement, focus: () => Promise<void>) {
  await document.fonts.ready;
  await expect.poll(() => target.checkVisibility({ contentVisibilityAuto: true })).toBe(true);
  const before = ancestors(target).map((element) => ({ element, paint: readPaint(element) }));
  await focus();
  await expect.element(target).toHaveFocus();
  expect(target.matches(':focus-visible')).toBe(true);

  const cues = before.flatMap(({ element, paint }) =>
    focusBounds(element, paint).map((bounds) => ({ element, bounds })),
  );
  expect(cues.length, 'Keyboard focus produces a nontransparent shadow or outline').toBeGreaterThan(
    0,
  );
  const clipped = cues.flatMap(({ element, bounds }) =>
    ancestors(element)
      .slice(1)
      .flatMap((ancestor) => {
        const boundary = paintBoundary(ancestor);
        if (boundary === null) return [];
        const edges = clippedEdges(bounds, boundary);
        return edges.length === 0
          ? []
          : [
              {
                owner: element.getAttribute('data-testid') ?? element.tagName,
                ancestor: ancestor.getAttribute('data-sidebar') ?? ancestor.tagName,
                edges,
              },
            ];
      }),
  );
  expect(clipped, 'Every edge of the keyboard focus cue clears ancestor paint clipping').toEqual(
    [],
  );
}

describe('ThreadHistoryPanel keyboard focus', () => {
  test('leaves an uncontained sidebar focus ring unobstructed', async () => {
    mount(
      <SidebarContent className="p-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="h-9">Uncontained chat</SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarContent>,
    );
    await expectUnclippedFocus(screen.getByRole('button', { name: 'Uncontained chat' }), () =>
      userEvent.tab(),
    );
  });

  test('keeps the history row focus ring inside every ancestor paint boundary', async () => {
    const thread: ThreadInfo = {
      threadId: 'focus-chat',
      agent: { id: 'codex-acp', name: 'Codex', source: 'registry' },
      title: 'Focus observation chat',
      status: 'exited',
      createdAt: 1,
      lastActivityAt: 2,
      lastSeq: 5,
      archived: true,
    };
    mount(
      <ThreadHistorySearchProvider scope="focus-ring-fixture">
        <ThreadHistoryPanel
          threads={[thread]}
          openThreadIds={new Set()}
          activeThreadId={null}
          onSelectThread={() => {}}
          mode="docked"
          panelId="focus-ring-history"
          onDismiss={() => {}}
        />
      </ThreadHistorySearchProvider>,
    );
    await expectUnclippedFocus(
      screen.getByTestId('agent-thread-history-open-focus-chat'),
      async () => {
        await userEvent.tab();
        await userEvent.tab();
      },
    );
  });

  test('keeps focused history ink visible while distant rows stay deferred', async () => {
    const threads: ThreadInfo[] = Array.from({ length: 512 }, (_, index) => ({
      threadId: `focus-${String(index).padStart(3, '0')}`,
      agent: { id: 'codex-acp', name: 'Codex', source: 'registry' },
      title: `Focus observation chat ${index}`,
      status: 'exited',
      createdAt: 1,
      lastActivityAt: 2,
      lastSeq: 5,
      archived: true,
    }));
    mount(
      <ThreadHistorySearchProvider scope="focus-ring-long-roster">
        <ThreadHistoryPanel
          threads={threads}
          openThreadIds={new Set()}
          activeThreadId={null}
          onSelectThread={() => {}}
          mode="docked"
          panelId="focus-ring-long-history"
          onDismiss={() => {}}
        />
      </ThreadHistorySearchProvider>,
    );
    await document.fonts.ready;
    const panel = screen.getByTestId('agent-thread-history-panel');
    const content = panel.querySelector<HTMLElement>('[data-sidebar="content"]');
    if (content === null) throw new Error('Expected the real history scroll container');
    const target = screen.getByTestId('agent-thread-history-open-focus-000');
    const row = target.closest('li');
    if (row === null) throw new Error('Expected the focused history row');
    const distant = screen.getByTestId('agent-thread-history-open-focus-511');
    const distantRow = distant.closest('li');
    if (distantRow === null) throw new Error('Expected the distant history row');
    expect(distantRow.getBoundingClientRect().top).toBeGreaterThan(
      content.getBoundingClientRect().bottom,
    );
    expect(distant.checkVisibility()).toBe(true);
    await expect.poll(() => distant.checkVisibility({ contentVisibilityAuto: true })).toBe(false);
    expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      content.getBoundingClientRect().top,
    );
    expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      content.getBoundingClientRect().bottom,
    );
    await expect.poll(() => target.checkVisibility({ contentVisibilityAuto: true })).toBe(true);
    const measure = () => {
      const rowBounds = row.getBoundingClientRect();
      const buttonBounds = target.getBoundingClientRect();
      return {
        row: { width: rowBounds.width, height: rowBounds.height },
        button: { width: buttonBounds.width, height: buttonBounds.height },
        scrollHeight: content.scrollHeight,
      };
    };
    const beforeFocus = measure();

    await expectUnclippedFocus(target, async () => {
      await userEvent.tab();
      await userEvent.tab();
      await expect.element(target).toHaveFocus();
      const focusedGeometry = measure();
      expect(focusedGeometry).toEqual(beforeFocus);
      expect(distant.checkVisibility()).toBe(true);
      expect(distant.checkVisibility({ contentVisibilityAuto: true })).toBe(false);
    });
  });
});

async function captureHistoryPixels() {
  const surface = screen.getByTestId('history-focus-surface');
  const base64 = await page.screenshot({
    element: surface,
    save: false,
  });
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('The browser did not supply a screenshot pixel reader');
  context.drawImage(image, 0, 0);
  const bounds = surface.getBoundingClientRect();
  return ({ x, y }: { x: number; y: number }) =>
    Array.from(
      context.getImageData(
        Math.floor(((x - bounds.left) * image.naturalWidth) / bounds.width),
        Math.floor(((y - bounds.top) * image.naturalHeight) / bounds.height),
        1,
        1,
      ).data,
    );
}

function focusPixelPoints(element: Element, before: Paint) {
  const rect = element.getBoundingClientRect();
  const cues = focusBounds(element, before);
  expect(cues.length, 'The pixel subject produces a nontransparent focus cue').toBeGreaterThan(0);
  const ink = cues.reduce(
    (bounds, cue) => ({
      top: Math.min(bounds.top, cue.top),
      right: Math.max(bounds.right, cue.right),
      bottom: Math.max(bounds.bottom, cue.bottom),
      left: Math.min(bounds.left, cue.left),
    }),
    { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
  );
  return {
    top: { x: rect.x + rect.width / 2, y: (rect.top + ink.top) / 2 },
    right: { x: (rect.right + ink.right) / 2, y: rect.y + rect.height / 2 },
    bottom: { x: rect.x + rect.width / 2, y: (rect.bottom + ink.bottom) / 2 },
    left: { x: (rect.left + ink.left) / 2, y: rect.y + rect.height / 2 },
  };
}

describe('ThreadHistoryPanel neighboring row focus paint', () => {
  test('paints every focus edge beside a selected and hovered history row', async () => {
    const threads: ThreadInfo[] = ['alpha', 'bravo'].map((threadId, index) => ({
      threadId,
      agent: { id: 'codex-acp', name: 'Codex', source: 'registry' },
      title: `Focus observation ${threadId}`,
      status: 'exited',
      createdAt: 1,
      lastActivityAt: 30 - index,
      lastSeq: 5,
      archived: true,
    }));
    function HistoryWithSelection() {
      const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
      return (
        <>
          <SidebarContent className="p-1">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton className="h-9">Uncontained comparison</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
          <ThreadHistorySearchProvider scope="focus-ring-sibling-paint">
            <ThreadHistoryPanel
              threads={threads}
              openThreadIds={new Set()}
              activeThreadId={activeThreadId}
              onSelectThread={setActiveThreadId}
              mode="docked"
              panelId="focus-ring-sibling-history"
              onDismiss={() => {}}
            />
          </ThreadHistorySearchProvider>
        </>
      );
    }
    mount(<HistoryWithSelection />);
    await document.fonts.ready;
    const control = screen.getByRole('button', { name: 'Uncontained comparison' });
    const target = screen.getByTestId('agent-thread-history-open-alpha');
    const neighbor = screen.getByTestId('agent-thread-history-open-bravo');
    const content = screen
      .getByTestId('agent-thread-history-panel')
      .querySelector<HTMLElement>('[data-sidebar="content"]');
    if (content === null) throw new Error('Expected the real history scroll container');
    const rows = [target, neighbor].map((button) => {
      const row = button.closest('li');
      if (row === null) throw new Error('Expected an ordinary history row');
      return row;
    });
    await expect.poll(() => target.checkVisibility({ contentVisibilityAuto: true })).toBe(true);
    await expect.poll(() => neighbor.checkVisibility({ contentVisibilityAuto: true })).toBe(true);
    const measure = () => ({
      boxes: [target, neighbor, ...rows].map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
      scrollHeight: content.scrollHeight,
      scrollTop: content.scrollTop,
    });
    const beforeGeometry = measure();
    const controlBefore = readPaint(control);
    const targetBefore = readPaint(target);
    const unfocusedPixels = await captureHistoryPixels();
    await userEvent.tab();
    await expect.element(control).toHaveFocus();
    expect(control.matches(':focus-visible')).toBe(true);
    const controlPoints = focusPixelPoints(control, controlBefore);
    const controlPixels = await captureHistoryPixels();
    const sides = ['top', 'right', 'bottom', 'left'] as const satisfies ReadonlyArray<
      keyof typeof controlPoints
    >;
    for (const side of sides) {
      expect(
        controlPixels(controlPoints[side]),
        `The control paints its ${side} focus edge`,
      ).not.toEqual(unfocusedPixels(controlPoints[side]));
    }
    await userEvent.click(neighbor);
    await expect.element(neighbor).toHaveAttribute('aria-current', 'true');
    await userEvent.hover(neighbor);
    expect(neighbor.matches(':hover')).toBe(true);
    const neighborStatePixels = await captureHistoryPixels();
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    await expect.element(target).toHaveFocus();
    expect(target.matches(':focus-visible')).toBe(true);
    await userEvent.hover(neighbor);
    expect(neighbor.matches(':hover')).toBe(true);
    await expect.element(neighbor).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
    for (const thread of threads) {
      for (const action of ['Rename', 'Delete']) {
        const button = screen.getByRole('button', { name: `${action} ${thread.title}` });
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        expect(button.contains(hit), `${action} remains a real row action hit target`).toBe(true);
      }
    }
    expect(measure()).toEqual(beforeGeometry);
    const targetPoints = focusPixelPoints(target, targetBefore);
    const focusedPixels = await captureHistoryPixels();
    await expect.element(target).toHaveFocus();
    const pixelEvidence = sides.map((side) => {
      const color = focusedPixels(targetPoints[side]);
      const before = neighborStatePixels(targetPoints[side]);
      return { side, color, changed: color.some((channel, index) => channel !== before[index]) };
    });
    const observed = pixelEvidence.map(({ side, changed }) => ({ side, changed }));
    const expected = sides.map((side) => ({ side, changed: true }));
    expect(
      observed,
      `Every focus edge paints beside the selected and hovered history row: ${JSON.stringify(pixelEvidence)}`,
    ).toEqual(expected);
  });
});

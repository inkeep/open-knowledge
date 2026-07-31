import { BASE16_SLOTS, type Base16Scheme, type Base16Slot } from '@inkeep/open-knowledge-core';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

/** A scheme with a distinct hex per slot so a swatch can be traced to its slot. */
function schemeOf(): Base16Scheme {
  const palette = {} as Base16Scheme['palette'];
  for (const [i, slot] of BASE16_SLOTS.entries()) {
    palette[slot] = `#${i.toString(16).repeat(6)}`;
  }
  return { name: 'T', variant: 'dark', palette };
}

async function renderCanvas(highlightSlot?: Base16Slot) {
  const { ThemePreviewCanvas } = await import('./ThemePreviewCanvas');
  return render(<ThemePreviewCanvas scheme={schemeOf()} highlightSlot={highlightSlot} />);
}

/** The terminal strip is the row anchored by the `$` shell prompt. */
function terminalStrip(getByText: (text: string) => HTMLElement): HTMLElement {
  return getByText('$').parentElement as HTMLElement;
}

describe('ThemePreviewCanvas terminal strip', () => {
  afterEach(cleanup);

  test('labels the yellow swatch base0A — the slot that drives ansi-yellow — not base09', async () => {
    // The strip pairs each ANSI accent with the slot ANSI_BY_SLOT maps it from:
    // red→base08, yellow→base0A, green→base0B, cyan→base0C, blue→base0D,
    // magenta→base0E. base09 is orange and has no ANSI slot, so it must not
    // appear in the strip — mislabelling the yellow swatch base09 teaches the
    // wrong slot→color association, which is the whole point of the preview.
    const { getByText } = await renderCanvas();
    const slots = [...terminalStrip(getByText).querySelectorAll('[data-slot]')].map((el) =>
      el.getAttribute('data-slot'),
    );
    expect(slots).toContain('base0A');
    expect(slots).not.toContain('base09');
  });

  test('highlighting base0A lights the terminal yellow swatch', async () => {
    const { getByText } = await renderCanvas('base0A');
    expect(
      terminalStrip(getByText).querySelectorAll('[data-slot="base0A"][data-lit="true"]').length,
    ).toBeGreaterThan(0);
  });
});

// @vitest-environment jsdom

import { PREVIEW_THEME_TOKENS } from '@inkeep/open-knowledge-core';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { HtmlPreview } from './html-preview.tsx';
import {
  DEFAULT_PREVIEW_RESERVE_PX,
  MAX_PREVIEW_HEIGHT_PX,
  resetPreviewHeightMemory,
} from './preview-height-memory.ts';

const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const encode = (html: string) => Buffer.from(html, 'utf8').toString('base64');

const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', {
    value: width,
    writable: true,
    configurable: true,
  });
};

const BLOCK_A = encode('<div id="a"><p>first block</p></div>');
const BLOCK_B = encode('<div id="b"><p>a different block</p></div>');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetPreviewHeightMemory();
  setViewportWidth(1024);
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const reservedEl = () =>
  container.querySelector<HTMLElement>('iframe[title="Interactive preview"]') ??
  container.querySelector<HTMLElement>('div[style]');

const reservedHeight = () => {
  const el = reservedEl();
  if (!el) throw new Error('component rendered nothing to reserve space with');
  const px = /height:\s*([\d.]+)px/.exec(el.getAttribute('style') ?? '');
  if (!px) throw new Error(`no inline height on reserved element: ${el.outerHTML}`);
  return Number(px[1]);
};

const render = (code: string) => {
  act(() => {
    root.render(createElement(HtmlPreview, { code }));
  });
};

const firstPaintReserve = (code: string) => {
  const fresh = document.createElement('div');
  document.body.appendChild(fresh);
  const freshRoot = createRoot(fresh);
  let height: number;
  try {
    act(() => {
      freshRoot.render(createElement(HtmlPreview, { code }));
    });
    const el =
      fresh.querySelector<HTMLElement>('iframe[title="Interactive preview"]') ??
      fresh.querySelector<HTMLElement>('div[style]');
    const px = /height:\s*([\d.]+)px/.exec(el?.getAttribute('style') ?? '');
    if (!px) throw new Error(`no inline height on first paint: ${fresh.innerHTML}`);
    height = Number(px[1]);
  } finally {
    act(() => freshRoot.unmount());
    fresh.remove();
  }
  return height;
};

const reportMeasuredHeight = (height: number) => {
  const iframe = container.querySelector('iframe[title="Interactive preview"]');
  if (!iframe) throw new Error('iframe has not mounted; cannot report a height');
  const srcDoc = iframe.getAttribute('srcdoc') ?? '';
  const id = /var ID=("[^"]+")/.exec(srcDoc);
  if (!id) throw new Error('srcDoc does not carry the preview id the component listens for');
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', { data: { __okpreview: JSON.parse(id[1]), h: height } }),
    );
  });
};

describe('HtmlPreview space reservation', () => {
  test('adopts the height the iframe reports', () => {
    render(BLOCK_A);
    reportMeasuredHeight(328);
    expect(reservedHeight()).toBe(328);
  });

  test('reserves a measured block at its measured height when it is rendered again', () => {
    render(BLOCK_A);
    reportMeasuredHeight(328);
    expect(reservedHeight()).toBe(328);

    expect(firstPaintReserve(BLOCK_A)).toBe(328);
  });

  test('does not lend one block its neighbour’s measured height', () => {
    render(BLOCK_A);
    reportMeasuredHeight(328);

    expect(firstPaintReserve(BLOCK_B)).not.toBe(328);
  });

  test('does not recall a height measured at a different viewport width', () => {
    setViewportWidth(360);
    render(BLOCK_A);
    reportMeasuredHeight(422);
    expect(reservedHeight()).toBe(422);

    setViewportWidth(1280);
    expect(firstPaintReserve(BLOCK_A)).toBe(DEFAULT_PREVIEW_RESERVE_PX);

    setViewportWidth(360);
    expect(firstPaintReserve(BLOCK_A)).toBe(422);
  });

  test('drops a block’s remembered height when the code prop changes on a live root', () => {
    render(BLOCK_A);
    reportMeasuredHeight(512);
    expect(reservedHeight()).toBe(512);

    render(BLOCK_B);
    expect(reservedHeight()).toBe(DEFAULT_PREVIEW_RESERVE_PX);
  });

  test('clamps an implausible reported height', () => {
    render(BLOCK_A);
    reportMeasuredHeight(MAX_PREVIEW_HEIGHT_PX + 1000);
    expect(reservedHeight()).toBe(MAX_PREVIEW_HEIGHT_PX);
  });

  test('answers the frame even before a theme resolves', () => {
    render(BLOCK_A);
    const iframe = container.querySelector<HTMLIFrameElement>(
      'iframe[title="Interactive preview"]',
    );
    if (!iframe) throw new Error('iframe did not render');

    const sent: unknown[] = [];
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: (msg: unknown) => sent.push(msg) },
      configurable: true,
    });

    reportMeasuredHeight(300);

    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((m) => (m as { __okpreview?: string }).__okpreview !== undefined)).toBe(true);
  });

  test('reserves the same height before and after the iframe replaces the placeholder', () => {
    render(BLOCK_A);
    reportMeasuredHeight(412);
    const withIframe = reservedHeight();

    expect(firstPaintReserve(BLOCK_A)).toBe(withIframe);
  });
});

describe('preview theme tokens track the editor', () => {
  const DARK_OVERRIDES = new Map([
    ['--background', 'sits on the docs card surface, not the editor canvas'],
    ['--card', 'sits on the docs card surface, not the editor canvas'],
    ['--border', 'docs card is lighter, so its border runs 14% alpha against the editor 10%'],
  ]);

  const tokensFrom = (srcDoc: string, selector: RegExp): Map<string, string> => {
    const block = selector.exec(srcDoc);
    if (!block) throw new Error(`no token block matching ${selector} in srcDoc`);
    return new Map(
      block[1]
        .split(';')
        .filter((decl) => decl.startsWith('--'))
        .map((decl) => {
          const colon = decl.indexOf(':');
          return [decl.slice(0, colon), decl.slice(colon + 1)] as const;
        }),
    );
  };

  const renderedTokens = () => {
    render(BLOCK_A);
    const iframe = container.querySelector<HTMLIFrameElement>(
      'iframe[title="Interactive preview"]',
    );
    if (!iframe) throw new Error('component rendered no iframe to read tokens from');
    const srcDoc = iframe.getAttribute('srcdoc') ?? '';
    return {
      light: tokensFrom(srcDoc, /:root\{([^}]*)\}/),
      dark: tokensFrom(srcDoc, /:root\[data-theme="dark"\]\{([^}]*)\}/),
    };
  };

  test('light-theme values match the tokens the editor injects', () => {
    const { light } = renderedTokens();
    const shared = PREVIEW_THEME_TOKENS.filter((token) => light.has(token.name));

    expect(shared.length).toBeGreaterThan(0);
    expect(shared.map((token) => [token.name, light.get(token.name)])).toEqual(
      shared.map((token) => [token.name, token.light]),
    );
  });

  test('dark-theme values match except where the docs surface deliberately differs', () => {
    const { dark } = renderedTokens();
    const shared = PREVIEW_THEME_TOKENS.filter(
      (token) => dark.has(token.name) && !DARK_OVERRIDES.has(token.name),
    );

    expect(shared.length).toBeGreaterThan(0);
    expect(shared.map((token) => [token.name, dark.get(token.name)])).toEqual(
      shared.map((token) => [token.name, token.dark]),
    );
  });

  test('every declared dark override is still a real divergence', () => {
    const { dark } = renderedTokens();

    for (const [name] of DARK_OVERRIDES) {
      const token = PREVIEW_THEME_TOKENS.find((candidate) => candidate.name === name);
      expect(token, `${name} is no longer an injected token`).toBeDefined();
      expect(
        dark.get(name),
        `${name} now matches the editor; drop it from DARK_OVERRIDES`,
      ).not.toBe(token?.dark);
    }
  });
});

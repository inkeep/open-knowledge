// @vitest-environment jsdom

/**
 * Layout-stability contract for `html preview` blocks.
 *
 * Every docs page that embeds one of these blocks reserves space for it before
 * the sandboxed iframe can report its real height. If that reserve is a
 * constant rather than the block's actual height, the whole page below the
 * preview reflows the moment the measurement lands — measured at up to 593px on
 * a single page, and visible to readers as the page "jumping" a beat after it
 * appears.
 *
 * The reserve is therefore behavioral, not cosmetic, and these tests pin it at
 * the only place a reader can observe it: the inline height the component
 * commits to on its very first paint, before any measurement exists for that
 * render.
 *
 * These run under jsdom via the per-file docblock above rather than a separate
 * DOM tier: docs has no `test:dom` config, and the component's whole contract
 * here is expressible through public DOM output, so the default `vitest run
 * src` gate is the right home.
 */

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

/** jsdom pins innerWidth, so width-keyed behaviour has to be driven explicitly. */
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
  // Heights are remembered in module scope, so without this each test would
  // inherit whatever the previous one measured and the suite would depend on
  // its own ordering.
  resetPreviewHeightMemory();
  // Width is part of the cache key, so a test that moved the viewport would
  // otherwise change what the next one recalls.
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

/** The element the component is currently reserving space with. */
const reservedEl = () =>
  container.querySelector<HTMLElement>('iframe[title="Interactive preview"]') ??
  container.querySelector<HTMLElement>('div[style]');

/** The inline height the component has committed to, in px. */
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

/**
 * The height the component reserves on first paint, before its effects run --
 * i.e. what a reader sees the instant the page appears. Rendering into a fresh
 * root mirrors what React does when a client-side navigation mounts the block.
 */
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

/**
 * Deliver the height the sandboxed iframe reports back. jsdom does not execute
 * srcDoc scripts, so the real inner script cannot run -- but it addresses its
 * message with an id embedded in that same srcDoc, so recovering the id from
 * the rendered attribute and posting the identical envelope exercises the
 * component's real listener rather than a stand-in for it.
 */
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
    // A reader navigating away from a docs page and back -- or between two
    // pages that both carry preview blocks -- remounts this component. The
    // height of BLOCK_A is known by then, so the remount must not fall back to
    // a placeholder guess and reflow the page a second time.
    render(BLOCK_A);
    reportMeasuredHeight(328);
    expect(reservedHeight()).toBe(328);

    expect(firstPaintReserve(BLOCK_A)).toBe(328);
  });

  test('does not lend one block its neighbour’s measured height', () => {
    // Guards the remount fix from over-reaching: heights are per-block, so a
    // block nobody has measured must not inherit an unrelated block's height.
    render(BLOCK_A);
    reportMeasuredHeight(328);

    expect(firstPaintReserve(BLOCK_B)).not.toBe(328);
  });

  test('does not recall a height measured at a different viewport width', () => {
    // The same block is legitimately a different height at a different width:
    // one settles at 240px in a desktop column and 422px on a phone. Recalling
    // across widths would reserve a number as wrong as the constant this
    // replaced, so a different width has to miss rather than hit.
    setViewportWidth(360);
    render(BLOCK_A);
    reportMeasuredHeight(422);
    expect(reservedHeight()).toBe(422);

    setViewportWidth(1280);
    expect(firstPaintReserve(BLOCK_A)).toBe(DEFAULT_PREVIEW_RESERVE_PX);

    // ...and returning to the original width still hits.
    setViewportWidth(360);
    expect(firstPaintReserve(BLOCK_A)).toBe(422);
  });

  test('drops a block’s remembered height when the code prop changes on a live root', () => {
    // A preview on one docs page can be reconciled onto the one on the next
    // rather than remounted. Without re-deriving during render the new block
    // would open at the previous block's height, which is the reflow this
    // whole change exists to remove.
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
    // The reply doubles as the acknowledgement that stops the frame
    // announcing. The frame ships in the server HTML and starts announcing at
    // parse time, so if the parent stayed silent until a theme resolved, a slow
    // hydration would leave the frame retrying and its height discarded.
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
    // The component renders a placeholder until it can pick a theme, then swaps
    // in the iframe. If those two disagree on height, hydration itself becomes a
    // second source of reflow, independent of measurement.
    render(BLOCK_A);
    reportMeasuredHeight(412);
    const withIframe = reservedHeight();

    expect(firstPaintReserve(BLOCK_A)).toBe(withIframe);
  });
});

/**
 * Token parity with the editor's preview iframe.
 *
 * The component's header promises an authored `html preview` block looks the
 * same in the OK editor and here. The editor injects its tokens from
 * `PREVIEW_THEME_TOKENS`, generated from `packages/app/src/globals.css` and
 * drift-tested there; this component hardcodes a hand-maintained copy. The two
 * drifted silently the first time a light-theme token moved in the app, which
 * is the failure these tests exist to make loud.
 *
 * Read off the rendered `srcDoc` rather than the module constants, because
 * `srcDoc` is what a reader's iframe actually resolves `var()` against.
 */
describe('preview theme tokens track the editor', () => {
  /** Dark-mode tokens the docs iframe deliberately does not take from the app. */
  const DARK_OVERRIDES = new Map([
    // The docs iframe sits on a docs card, not the editor's canvas, so its dark
    // surfaces are lifted to stay visible against the page behind them.
    ['--background', 'sits on the docs card surface, not the editor canvas'],
    ['--card', 'sits on the docs card surface, not the editor canvas'],
    // Not a notation difference: `/ 0.14` is 14% alpha and `/ 10%` is 10%, so
    // the docs border is genuinely more opaque. The docs card sits lighter than
    // the editor canvas, where a white border at the editor's alpha would carry
    // less separation, which is the only reason the gap holds up. Nobody
    // recorded the intent when the constant was hand-copied, so treat the value
    // as load-bearing until someone re-derives it rather than normalizing the
    // two strings together.
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
    // Without this the allowlist becomes a place stale exemptions accumulate: an
    // override that has since converged would keep a real future drift on that
    // token permanently exempt.
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

/**
 * Unit tests for the WikiLinkEmbed image NodeView DOM builder. Pins the
 * desktop-origin rewrite: `dom.setAttribute('src',
 * …)` must route through `toDesktopAssetHref` so server-absolute paths land
 * on the utility-process API origin in Electron. Without this, `![[photo.png]]`
 * embeds break under `file://` page contexts the same way plain-markdown
 * images did before this rewrite.
 *
 * Pattern: bare-Bun (no happy-dom). The DOM-builder accepts an injectable
 * `doc: Pick<Document, 'createElement'>` for exactly this purpose; we feed a
 * stub element that records `setAttribute` calls.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { buildWikiLinkEmbedImageDom } from './wiki-link-embed.ts';

interface RecordingElement {
  attrs: Map<string, string>;
  setAttribute: (k: string, v: string) => void;
}

function makeStubDoc(): {
  doc: { createElement: () => RecordingElement };
  lastEl: () => RecordingElement | null;
} {
  let last: RecordingElement | null = null;
  return {
    doc: {
      createElement: () => {
        const attrs = new Map<string, string>();
        const el: RecordingElement = {
          attrs,
          setAttribute: (k, v) => {
            attrs.set(k, v);
          },
        };
        last = el;
        return el;
      },
    },
    lastEl: () => last,
  };
}

const g = globalThis as { window?: unknown };

afterEach(() => {
  delete g.window;
});

describe('buildWikiLinkEmbedImageDom — desktop-origin rewrite', () => {
  test('without window.okDesktop, src stays server-absolute', () => {
    const { doc, lastEl } = makeStubDoc();
    buildWikiLinkEmbedImageDom({
      nodeId: 'wle-1',
      target: 'photo.png',
      alias: null,
      src: '/attachments/photo.png',
      doc: doc as unknown as Pick<Document, 'createElement'>,
    });
    expect(lastEl()?.attrs.get('src')).toBe('/attachments/photo.png');
  });

  test('with window.okDesktop.config.apiOrigin, src is prefixed onto the origin', () => {
    g.window = { okDesktop: { config: { apiOrigin: 'http://127.0.0.1:54321' } } };
    const { doc, lastEl } = makeStubDoc();
    buildWikiLinkEmbedImageDom({
      nodeId: 'wle-2',
      target: 'photo.png',
      alias: null,
      src: '/attachments/photo.png',
      doc: doc as unknown as Pick<Document, 'createElement'>,
    });
    expect(lastEl()?.attrs.get('src')).toBe('http://127.0.0.1:54321/attachments/photo.png');
  });

  test('non-server-absolute src (relative) passes through untouched even under desktop', () => {
    g.window = { okDesktop: { config: { apiOrigin: 'http://127.0.0.1:54321' } } };
    const { doc, lastEl } = makeStubDoc();
    buildWikiLinkEmbedImageDom({
      nodeId: 'wle-3',
      target: 'photo.png',
      alias: null,
      src: 'photo.png',
      doc: doc as unknown as Pick<Document, 'createElement'>,
    });
    // toDesktopAssetHref short-circuits on non-`/`-prefixed input — the chip
    // should carry the bare target without an origin prefix.
    expect(lastEl()?.attrs.get('src')).toBe('photo.png');
  });
});

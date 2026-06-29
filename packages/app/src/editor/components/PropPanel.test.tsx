
import { describe, expect, test } from 'bun:test';
import { builtInComponents, type PropDef } from '@inkeep/open-knowledge-core';
import { renderToString } from 'react-dom/server';
import type { JsxComponentDescriptor } from '../registry/types.ts';

const { countAdvancedSet, PropPanel, persistAdvancedOpenState, readAdvancedOpenState } =
  await import('./PropPanel.tsx');
const { getAutoFocusedPropName } = await import('../utils/editor-strings.ts');


interface FakeStorage {
  store: Record<string, string>;
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
  clear: () => void;
}

function makeFakeStorage(): FakeStorage {
  const store: Record<string, string> = {};
  return {
    store,
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v;
    },
    removeItem: (k) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
}

function withFakeStorage<T>(fn: (s: FakeStorage) => T): T {
  const fake = makeFakeStorage();
  const original = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = fake as unknown as Storage;
  try {
    return fn(fake);
  } finally {
    if (original === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    } else {
      (globalThis as { localStorage?: unknown }).localStorage = original;
    }
  }
}


function NoopComponent() {
  return null;
}

function makeCanonicalDescriptor(name: string, props: PropDef[]): JsxComponentDescriptor {
  return {
    name,
    surface: 'canonical',
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    hasChildren: false,
    props,
    serialize: () => ({ type: 'paragraph', children: [] }),
    Component: NoopComponent,
    reactNodePropNames: new Set(),
  };
}


describe('countAdvancedSet', () => {
  test('returns 0 when no advanced props are set away from default', () => {
    const advanced: PropDef[] = [
      {
        name: 'loading',
        type: 'enum',
        enumValues: ['eager', 'lazy'],
        defaultValue: 'lazy',
        advanced: true,
        required: false,
      },
      { name: 'srcset', type: 'string', advanced: true, required: false },
    ];
    expect(countAdvancedSet(advanced, {})).toBe(0);
    expect(countAdvancedSet(advanced, { loading: 'lazy' })).toBe(0);
    expect(countAdvancedSet(advanced, { srcset: undefined })).toBe(0);
  });

  test('counts a prop as set when its value differs from the declared default', () => {
    const advanced: PropDef[] = [
      {
        name: 'loading',
        type: 'enum',
        enumValues: ['eager', 'lazy'],
        defaultValue: 'lazy',
        advanced: true,
        required: false,
      },
      { name: 'srcset', type: 'string', advanced: true, required: false },
      { name: 'title', type: 'string', advanced: true, required: false },
    ];
    expect(countAdvancedSet(advanced, { loading: 'eager', srcset: 'x.png 1x', title: 'tip' })).toBe(
      3,
    );
  });

  test('a prop with no defaultValue counts as set when value is anything but undefined', () => {
    const advanced: PropDef[] = [
      { name: 'srcset', type: 'string', advanced: true, required: false },
    ];
    expect(countAdvancedSet(advanced, { srcset: '' })).toBe(1);
    expect(countAdvancedSet(advanced, { srcset: undefined })).toBe(0);
  });
});

describe('localStorage round-trip', () => {
  test('returns false when no entry is present', () => {
    withFakeStorage(() => {
      expect(readAdvancedOpenState('img')).toBe(false);
    });
  });

  test('persist + read round-trip preserves true', () => {
    withFakeStorage((fake) => {
      persistAdvancedOpenState('img', true);
      expect(fake.store['ok.propPanel.advanced.img']).toBe('true');
      expect(readAdvancedOpenState('img')).toBe(true);
    });
  });

  test('persist false stores false', () => {
    withFakeStorage((fake) => {
      persistAdvancedOpenState('img', true);
      persistAdvancedOpenState('img', false);
      expect(fake.store['ok.propPanel.advanced.img']).toBe('false');
      expect(readAdvancedOpenState('img')).toBe(false);
    });
  });

  test('per-descriptor scoping — opening img does not open Callout', () => {
    withFakeStorage(() => {
      persistAdvancedOpenState('img', true);
      expect(readAdvancedOpenState('Callout')).toBe(false);
      expect(readAdvancedOpenState('img')).toBe(true);
    });
  });

  test('returns false when localStorage is unavailable', () => {
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    delete (globalThis as { localStorage?: unknown }).localStorage;
    try {
      expect(readAdvancedOpenState('img')).toBe(false);
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = original;
    }
  });
});


describe('PropPanel — Advanced collapsible section', () => {
  test('(a) descriptor with no advanced props renders no Collapsible', () => {
    const d = makeCanonicalDescriptor('NoAdvanced', [
      { name: 'src', type: 'string', required: true },
      { name: 'alt', type: 'string', required: false },
    ]);
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).not.toContain('data-prop-panel-advanced-trigger');
    expect(html).not.toContain('data-slot="collapsible"');
  });

  test('(b) descriptor with advanced props renders Collapsible closed by default', () => {
    const d = makeCanonicalDescriptor('WithAdvanced', [
      { name: 'src', type: 'string', required: true },
      { name: 'srcset', type: 'string', advanced: true, required: false },
    ]);
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).toContain('data-prop-panel-advanced-trigger');
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('Advanced');
  });

  test('(d) count badge: hidden when 0; shows N when N props non-default', () => {
    const d = makeCanonicalDescriptor('Img', [
      { name: 'src', type: 'string', required: true },
      {
        name: 'loading',
        type: 'enum',
        enumValues: ['eager', 'lazy'],
        defaultValue: 'lazy',
        advanced: true,
        required: false,
      },
      { name: 'srcset', type: 'string', advanced: true, required: false },
      { name: 'title', type: 'string', advanced: true, required: false },
    ]);

    const htmlZero = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(htmlZero).not.toContain('data-prop-panel-advanced-count');

    const htmlTwo = withFakeStorage(() =>
      renderToString(
        <PropPanel
          descriptor={d}
          values={{ loading: 'eager', srcset: 'x.png 1x' }}
          onChange={() => {}}
        />,
      ),
    );
    expect(htmlTwo).toContain('data-prop-panel-advanced-count');
    expect(htmlTwo).toContain('>2<');
  });

  test('(b/e) initial open state honors localStorage on mount', () => {
    const d = makeCanonicalDescriptor('Img', [
      { name: 'srcset', type: 'string', advanced: true, required: false },
    ]);
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('Img', true);
      return renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />);
    });
    expect(html).toContain('data-state="open"');
  });
});

describe('getAutoFocusedPropName', () => {
  test('returns null when no prop has autoFocus', () => {
    const props: PropDef[] = [
      { name: 'src', type: 'string', required: true },
      { name: 'alt', type: 'string', required: false },
    ];
    expect(getAutoFocusedPropName(props)).toBeNull();
  });

  test('returns the first PropDefString with autoFocus: true', () => {
    const props: PropDef[] = [
      { name: 'alt', type: 'string', required: false },
      { name: 'src', type: 'string', required: true, autoFocus: true },
      { name: 'title', type: 'string', required: false, autoFocus: true },
    ];
    expect(getAutoFocusedPropName(props)).toBe('src');
  });

  test('skips hidden props', () => {
    const props: PropDef[] = [
      { name: 'internal', type: 'string', required: false, autoFocus: true, hidden: true },
      { name: 'src', type: 'string', required: true, autoFocus: true },
    ];
    expect(getAutoFocusedPropName(props)).toBe('src');
  });

  test('only matches PropDefString — number/enum/boolean autoFocus is not honored', () => {
    const props: PropDef[] = [
      // biome-ignore lint/suspicious/noExplicitAny: synthetic shape — autoFocus only valid on string in the type
      { name: 'count', type: 'number', required: false, autoFocus: true } as any,
      { name: 'src', type: 'string', required: true, autoFocus: true },
    ];
    expect(getAutoFocusedPropName(props)).toBe('src');
  });

  test('skips advanced props — would be inside collapsed CollapsibleContent on mount', () => {
    const props: PropDef[] = [
      { name: 'srcset', type: 'string', required: false, autoFocus: true, advanced: true },
      { name: 'src', type: 'string', required: true, autoFocus: true },
    ];
    expect(getAutoFocusedPropName(props)).toBe('src');
  });

  test('returns null when only advanced prop has autoFocus (no common-tier fallback)', () => {
    const props: PropDef[] = [
      { name: 'srcset', type: 'string', required: false, autoFocus: true, advanced: true },
      { name: 'alt', type: 'string', required: false },
    ];
    expect(getAutoFocusedPropName(props)).toBeNull();
  });
});

describe('PropPanel — upload button affordance', () => {
  test('(a) renders upload button when prop has accept set', () => {
    const d = makeCanonicalDescriptor('img', [
      {
        name: 'src',
        type: 'string',
        required: true,
        accept: ['image/png', 'image/jpeg'],
      },
    ]);
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).toContain('data-prop-upload-trigger');
    expect(html).toContain('data-prop-upload-input');
    expect(html).toContain('accept="image/png,image/jpeg"');
  });

  test('(a) does NOT render upload button when prop has no accept', () => {
    const d = makeCanonicalDescriptor('Callout', [
      { name: 'title', type: 'string', required: false },
    ]);
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).not.toContain('data-prop-upload-trigger');
    expect(html).not.toContain('data-prop-upload-input');
  });

  test('upload button surfaces visible "Upload from computer" text as its accessible name', () => {
    const d = makeCanonicalDescriptor('img', [
      { name: 'src', type: 'string', required: true, accept: ['image/png'] },
    ]);
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).toMatch(/data-prop-upload-trigger="">.*Upload from computer/);
  });
});

describe('PropPanel — autoFocus marker on string Input', () => {
  test('(e) descriptor with autoFocus prop renders data-prop-autofocus on its Input', () => {
    const d = makeCanonicalDescriptor('img', [
      { name: 'src', type: 'string', required: true, autoFocus: true },
      { name: 'alt', type: 'string', required: false },
    ]);
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    const matches = html.match(/data-prop-autofocus=""/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test('(f) descriptor without autoFocus renders no autofocus marker', () => {
    const d = makeCanonicalDescriptor('Callout', [
      { name: 'title', type: 'string', required: false },
      { name: 'icon', type: 'string', required: false },
    ]);
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).not.toContain('data-prop-autofocus');
  });
});


function findBuiltIn(name: string): JsxComponentDescriptor {
  const meta = builtInComponents.find((m) => m.name === name);
  if (!meta) throw new Error(`built-in not found: ${name}`);
  return {
    ...meta,
    Component: NoopComponent,
    reactNodePropNames: new Set(),
  } as JsxComponentDescriptor;
}

describe('PropPanel — descriptor.props narrowing (real registry)', () => {
  test('WikiEmbedImage renders only the alias control', () => {
    const d = findBuiltIn('WikiEmbedImage');
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).toContain('id="prop-alias"');
    expect(html).not.toContain('id="prop-src"');
    expect(html).not.toContain('id="prop-alt"');
    expect(html).not.toContain('id="prop-width"');
    expect(html).not.toContain('id="prop-height"');
    expect(html).not.toContain('id="prop-srcset"');
    expect(html).not.toContain('id="prop-sizes"');
    expect(html).not.toContain('id="prop-loading"');
    expect(html).not.toContain('id="prop-title"');
    expect(html).not.toContain('data-prop-panel-advanced-trigger');
    const propIds = html.match(/id="prop-[^"]+"/g) ?? [];
    expect(propIds.length).toBe(1);
  });

  test('WikiEmbedVideo renders only the alias control', () => {
    const d = findBuiltIn('WikiEmbedVideo');
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).toContain('id="prop-alias"');
    expect(html).not.toContain('id="prop-src"');
    expect(html).not.toContain('id="prop-controls"');
    expect(html).not.toContain('id="prop-poster"');
    expect(html).not.toContain('data-prop-panel-advanced-trigger');
    const propIds = html.match(/id="prop-[^"]+"/g) ?? [];
    expect(propIds.length).toBe(1);
  });

  test('WikiEmbedAudio renders only the alias control', () => {
    const d = findBuiltIn('WikiEmbedAudio');
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).toContain('id="prop-alias"');
    expect(html).not.toContain('id="prop-src"');
    expect(html).not.toContain('id="prop-controls"');
    expect(html).not.toContain('data-prop-panel-advanced-trigger');
    const propIds = html.match(/id="prop-[^"]+"/g) ?? [];
    expect(propIds.length).toBe(1);
  });

  test('canonical img descriptor renders the full htmlImgProps surface', () => {
    const d = findBuiltIn('img');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('img', true);
      return renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />);
    });
    expect(html).toContain('id="prop-src"');
    expect(html).toContain('id="prop-alt"');
    expect(html).not.toContain('id="prop-align"');
    expect(html).toContain('data-prop-panel-advanced-trigger');
    expect(html).toContain('id="prop-width"');
    expect(html).toContain('id="prop-height"');
    expect(html).toContain('id="prop-srcset"');
    expect(html).toContain('id="prop-sizes"');
    expect(html).toContain('id="prop-loading"');
    expect(html).toContain('id="prop-title"');
    expect(html).toContain('id="prop-decoding"');
    expect(html).toContain('id="prop-fetchpriority"');
    expect(html).toContain('id="prop-crossorigin"');
    expect(html).toContain('id="prop-referrerpolicy"');
    const propIds = html.match(/id="prop-[^"]+"/g) ?? [];
    expect(propIds.length).toBe(12);
  });

  test('canonical video descriptor: align is hidden from PropPanel (bubble-menu owns it)', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('video', true);
      return renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />);
    });
    expect(html).toContain('id="prop-src"');
    expect(html).not.toContain('id="prop-align"');
  });

  test('canonical Embed descriptor: align is hidden from PropPanel (bubble-menu owns it)', () => {
    const d = findBuiltIn('Embed');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('Embed', true);
      return renderToString(
        <PropPanel descriptor={d} values={{ src: 'https://example.com' }} onChange={() => {}} />,
      );
    });
    expect(html).toContain('id="prop-src"');
    expect(html).not.toContain('id="prop-align"');
  });
});

describe('PropPanel — CodeMirror branch (string props with `language`)', () => {
  test('Math.formula renders the CodeMirror wrapper with `data-prop-language="latex"`', () => {
    const d = findBuiltIn('Math');
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).toContain('data-prop-codemirror=""');
    expect(html).toContain('data-prop-language="latex"');
    expect(html).toContain('id="prop-formula"');
  });

  test('MermaidFence.chart is hidden — PropPanel renders no CodeMirror surface for it', () => {
    const d = findBuiltIn('MermaidFence');
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).toBe('');
    expect(html).not.toContain('id="prop-chart"');
    expect(html).not.toContain('data-prop-language="mermaid"');
  });
});

function renderEmbedWithAdvancedOpen(values: Record<string, unknown>): string {
  const d = findBuiltIn('Embed');
  return withFakeStorage(() => {
    persistAdvancedOpenState('Embed', true);
    return renderToString(<PropPanel descriptor={d} values={values} onChange={() => {}} />);
  });
}

describe('PropPanel — CSS-length input', () => {
  test('valid CSS length (100px) renders the wrapper marker and no error', () => {
    const html = renderEmbedWithAdvancedOpen({ src: 'https://example.com', width: '100px' });
    expect(html).toContain('data-prop-css-length-input=""');
    expect(html).not.toContain('data-prop-css-length-error');
    expect(html).not.toContain('aria-invalid="true"');
  });

  test('invalid CSS length (abc) surfaces inline error + aria-invalid + polite live region', () => {
    const html = renderEmbedWithAdvancedOpen({ src: 'https://example.com', width: 'abc' });
    expect(html).toContain('data-prop-css-length-input=""');
    expect(html).toContain('data-prop-css-length-error');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
  });

  test('empty CSS length renders the wrapper but suppresses the error chrome', () => {
    const html = renderEmbedWithAdvancedOpen({ src: 'https://example.com' });
    expect(html).toContain('data-prop-css-length-input=""');
    expect(html).not.toContain('data-prop-css-length-error');
    expect(html).not.toContain('aria-invalid="true"');
  });

  test('keyword value (auto) is accepted — no error chrome', () => {
    const html = renderEmbedWithAdvancedOpen({ src: 'https://example.com', height: 'auto' });
    expect(html).toContain('data-prop-css-length-input=""');
    expect(html).not.toContain('data-prop-css-length-error');
    expect(html).not.toContain('aria-invalid="true"');
  });
});

describe('PropPanel — media URL validation', () => {
  test('video src with YouTube URL is accepted (Video dispatches to iframe — no error)', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() =>
      renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://www.youtube.com/watch?v=rekaSOwGMu0' }}
          onChange={() => {}}
        />,
      ),
    );
    expect(html).not.toContain('data-prop-media-error');
    expect(html).not.toContain('not yet supported');
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('id="prop-src"');
    expect(html).toContain('https://www.youtube.com/watch?v=rekaSOwGMu0');
  });

  test('video preload hides on YouTube URLs (no iframe equivalent)', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('video', true);
      return renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }}
          onChange={() => {}}
        />,
      );
    });
    expect(html).toContain('id="prop-controls"');
    expect(html).toContain('id="prop-autoplay"');
    expect(html).toContain('id="prop-loop"');
    expect(html).toContain('id="prop-muted"');
    expect(html).not.toContain('id="prop-preload"');
    expect(html).not.toContain('data-prop-name="preload"');
  });

  test('video preload renders for non-YouTube sources (advanced section)', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('video', true);
      return renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://example.com/clip.mp4' }}
          onChange={() => {}}
        />,
      );
    });
    expect(html).toContain('id="prop-preload"');
  });

  test('video src with Vimeo URL is accepted (Video dispatches to iframe — no error)', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() =>
      renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://vimeo.com/76979871' }}
          onChange={() => {}}
        />,
      ),
    );
    expect(html).not.toContain('data-prop-media-error');
    expect(html).not.toContain('not yet supported');
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('id="prop-src"');
    expect(html).toContain('https://vimeo.com/76979871');
  });

  test('video controls + preload + poster + playsinline hide on Vimeo URLs (no honest equivalent)', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('video', true);
      return renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://vimeo.com/76979871' }}
          onChange={() => {}}
        />,
      );
    });
    expect(html).toContain('id="prop-autoplay"');
    expect(html).toContain('id="prop-muted"');
    expect(html).toContain('id="prop-loop"');
    expect(html).not.toContain('id="prop-controls"');
    expect(html).not.toContain('data-prop-name="controls"');
    expect(html).not.toContain('id="prop-preload"');
    expect(html).not.toContain('data-prop-name="preload"');
    expect(html).not.toContain('id="prop-poster"');
    expect(html).not.toContain('data-prop-name="poster"');
    expect(html).not.toContain('id="prop-playsinline"');
    expect(html).not.toContain('data-prop-name="playsinline"');
  });

  test('video controls still renders for YouTube + HTML5 sources (honored at runtime)', () => {
    const d = findBuiltIn('video');
    const ytHtml = withFakeStorage(() => {
      persistAdvancedOpenState('video', true);
      return renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }}
          onChange={() => {}}
        />,
      );
    });
    expect(ytHtml).toContain('id="prop-controls"');

    const html5Html = withFakeStorage(() => {
      persistAdvancedOpenState('video', true);
      return renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://example.com/clip.mp4' }}
          onChange={() => {}}
        />,
      );
    });
    expect(html5Html).toContain('id="prop-controls"');
  });

  test('video src with Loom URL is accepted (Video dispatches to iframe — no error)', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() =>
      renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://www.loom.com/share/abc123def456ghi789jk' }}
          onChange={() => {}}
        />,
      ),
    );
    expect(html).not.toContain('data-prop-media-error');
    expect(html).not.toContain('not yet supported');
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('id="prop-src"');
    expect(html).toContain('https://www.loom.com/share/abc123def456ghi789jk');
  });

  test('video controls + poster + preload + playsinline + loop hide on Loom URLs (no honest equivalent)', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('video', true);
      return renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://www.loom.com/share/abc123def456ghi789jk' }}
          onChange={() => {}}
        />,
      );
    });
    expect(html).toContain('id="prop-autoplay"');
    expect(html).toContain('id="prop-muted"');
    expect(html).toContain('id="prop-width"');
    expect(html).toContain('id="prop-height"');
    expect(html).toContain('id="prop-title"');
    expect(html).not.toContain('id="prop-controls"');
    expect(html).not.toContain('data-prop-name="controls"');
    expect(html).not.toContain('id="prop-poster"');
    expect(html).not.toContain('data-prop-name="poster"');
    expect(html).not.toContain('id="prop-preload"');
    expect(html).not.toContain('data-prop-name="preload"');
    expect(html).not.toContain('id="prop-playsinline"');
    expect(html).not.toContain('data-prop-name="playsinline"');
    expect(html).not.toContain('id="prop-loop"');
    expect(html).not.toContain('data-prop-name="loop"');
  });

  test('video loop still renders for YouTube + Vimeo + HTML5 sources', () => {
    const d = findBuiltIn('video');
    for (const src of [
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      'https://vimeo.com/22439234',
      'https://example.com/clip.mp4',
    ]) {
      const html = withFakeStorage(() => {
        persistAdvancedOpenState('video', true);
        return renderToString(<PropPanel descriptor={d} values={{ src }} onChange={() => {}} />);
      });
      expect(html).toContain('id="prop-loop"');
    }
  });

  test('video src with wrong-extension URL renders inline error', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() =>
      renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://example.com/page.html' }}
          onChange={() => {}}
        />,
      ),
    );
    expect(html).toContain('data-prop-media-error');
  });

  test('video src with valid mp4 URL renders no error', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() =>
      renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://example.com/clip.mp4' }}
          onChange={() => {}}
        />,
      ),
    );
    expect(html).not.toContain('data-prop-media-error');
  });

  test('video src with data: URI renders inline error (sanitizer would strip to #)', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() =>
      renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'data:video/mp4;base64,AAAA' }}
          onChange={() => {}}
        />,
      ),
    );
    expect(html).toContain('data-prop-media-error');
    expect(html).toContain('Data URIs are not supported');
  });

  test('video src with extensionless CDN URL renders no error (no false positive)', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() =>
      renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://cdn.example.com/media/signed-abc123' }}
          onChange={() => {}}
        />,
      ),
    );
    expect(html).not.toContain('data-prop-media-error');
  });

  test("video src empty renders no error (don't show error on blank input)", () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).not.toContain('data-prop-media-error');
  });

  test('video src input has placeholder describing accepted URL shapes', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).toContain('placeholder=');
    expect(html.toLowerCase()).toContain('.mp4');
  });

  test('img src with YouTube URL renders inline error (image command shares the input)', () => {
    const d = findBuiltIn('img');
    const html = withFakeStorage(() =>
      renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://www.youtube.com/watch?v=abc' }}
          onChange={() => {}}
        />,
      ),
    );
    expect(html).toContain('data-prop-media-error');
    expect(html).toContain('YouTube');
    expect(html).not.toContain('embeds');
  });

  test('audio src with YouTube URL renders inline error (audio command shares the input)', () => {
    const d = findBuiltIn('audio');
    const html = withFakeStorage(() =>
      renderToString(
        <PropPanel
          descriptor={d}
          values={{ src: 'https://www.youtube.com/watch?v=abc' }}
          onChange={() => {}}
        />,
      ),
    );
    expect(html).toContain('data-prop-media-error');
    expect(html).toContain('YouTube');
  });

  test('video poster (advanced prop) now validates too — YouTube URL errors', () => {
    const d = findBuiltIn('video');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('video', true);
      return renderToString(
        <PropPanel
          descriptor={d}
          values={{ poster: 'https://www.youtube.com/watch?v=abc' }}
          onChange={() => {}}
        />,
      );
    });
    expect(html).toContain('id="prop-poster"');
    expect(html).toContain('data-prop-media-error');
    expect(html).toContain('YouTube');
    expect(html).toContain('not direct image files');
    expect(html).not.toContain('not yet supported');
  });

  test('non-media string props (e.g. img.alt) render NO placeholder/error machinery', () => {
    const d = findBuiltIn('img');
    const html = withFakeStorage(() =>
      renderToString(
        <PropPanel
          descriptor={d}
          values={{ alt: 'a long alt text describing the image' }}
          onChange={() => {}}
        />,
      ),
    );
    expect(html).toContain('id="prop-alt"');
    expect(html).not.toMatch(/id="prop-alt"[^>]*>[^<]*<[^>]*data-prop-media-error/);
  });
});

describe('PropPanel — Callout defaultOpen conditional visibility', () => {
  test('defaultOpen is hidden when collapsible is explicitly false', () => {
    const d = findBuiltIn('Callout');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('Callout', true);
      return renderToString(
        <PropPanel
          descriptor={d}
          values={{ type: 'note', title: 'Heads up', collapsible: false }}
          onChange={() => {}}
        />,
      );
    });
    expect(html).toContain('id="prop-collapsible"');
    expect(html).toContain('id="prop-icon"');
    expect(html).not.toContain('id="prop-defaultOpen"');
    expect(html).not.toContain('data-prop-name="defaultOpen"');
  });

  test('defaultOpen is hidden when collapsible is absent from values', () => {
    const d = findBuiltIn('Callout');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('Callout', true);
      return renderToString(
        <PropPanel
          descriptor={d}
          values={{ type: 'note', title: 'Heads up' }}
          onChange={() => {}}
        />,
      );
    });
    expect(html).toContain('id="prop-collapsible"');
    expect(html).not.toContain('id="prop-defaultOpen"');
    expect(html).not.toContain('data-prop-name="defaultOpen"');
  });

  test('defaultOpen renders when collapsible is true', () => {
    const d = findBuiltIn('Callout');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('Callout', true);
      return renderToString(
        <PropPanel
          descriptor={d}
          values={{ type: 'note', title: 'Heads up', collapsible: true }}
          onChange={() => {}}
        />,
      );
    });
    expect(html).toContain('id="prop-defaultOpen"');
  });
});

describe('PropPanel — iconPicker branch', () => {
  test('Callout.icon renders IconPickerInput (text input + trigger), not the bare Input', () => {
    const d = findBuiltIn('Callout');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('Callout', true);
      return renderToString(
        <PropPanel descriptor={d} values={{ type: 'note' }} onChange={() => {}} />,
      );
    });
    expect(html).toContain('id="prop-icon"');
    expect(html).toContain('data-icon-picker-input');
    expect(html).toContain('data-icon-picker-trigger');
  });

  test('Accordion.icon renders IconPickerInput (shared picker via descriptor opt-in)', () => {
    const d = findBuiltIn('Accordion');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('Accordion', true);
      return renderToString(
        <PropPanel descriptor={d} values={{ title: 'x' }} onChange={() => {}} />,
      );
    });
    expect(html).toContain('id="prop-icon"');
    expect(html).toContain('data-icon-picker-input');
    expect(html).toContain('data-icon-picker-trigger');
  });
});

describe('PropPanel — colorPicker branch', () => {
  test('Callout.color renders ColorPickerInput (text input + swatch trigger), not the bare Input', () => {
    const d = findBuiltIn('Callout');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('Callout', true);
      return renderToString(
        <PropPanel descriptor={d} values={{ type: 'note' }} onChange={() => {}} />,
      );
    });
    expect(html).toContain('id="prop-color"');
    expect(html).toContain('data-color-picker-input');
    expect(html).toContain('data-color-picker-trigger');
    expect(html).toContain('data-color-picker-native');
  });

  test('Callout.color swatch + clear button show only when value is non-empty', () => {
    const d = findBuiltIn('Callout');
    const emptyHtml = withFakeStorage(() => {
      persistAdvancedOpenState('Callout', true);
      return renderToString(
        <PropPanel descriptor={d} values={{ type: 'note' }} onChange={() => {}} />,
      );
    });
    expect(emptyHtml).not.toContain('data-color-picker-swatch');
    expect(emptyHtml).not.toContain('data-color-picker-clear');

    const filledHtml = withFakeStorage(() => {
      persistAdvancedOpenState('Callout', true);
      return renderToString(
        <PropPanel
          descriptor={d}
          values={{ type: 'note', color: '#F05032' }}
          onChange={() => {}}
        />,
      );
    });
    expect(filledHtml).toContain('data-color-picker-swatch');
    expect(filledHtml).toContain('data-color-picker-clear');
  });
});


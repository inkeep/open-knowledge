/**
 * PropPanel — unit tests for the Advanced collapsible section, the
 * non-default-set count helper, the per-descriptor localStorage round-trip,
 * the autoFocus marker, and the upload affordance.
 *
 * Repo convention (see ActivityPanelBurstRow.test.tsx, use-editor-mode.test.ts):
 * no @testing-library/react, no happy-dom. Structural cases use
 * `renderToString`; storage helpers are unit-tested with localStorage fakes.
 *
 * Interactive cases (trigger click toggling open/closed; re-mount reading
 * persisted state through DOM lifecycle) are covered indirectly:
 *   - The Collapsible's `open`/`onOpenChange` wiring is structural; if the
 *     `onOpenChange` calls both setState and `persistAdvancedOpenState`, a
 *     remount reading via `readAdvancedOpenState` will reflect the change.
 *     Both halves are unit-tested below.
 *   - The Playwright suite at packages/app/tests/a11y/component-blocks.e2e.ts
 *     (Tab cycle, Esc close) exercises the panel end-to-end.
 */

import { describe, expect, test } from 'bun:test';
import { builtInComponents, type PropDef } from '@inkeep/open-knowledge-core';
import { renderToString } from 'react-dom/server';
import type { JsxComponentDescriptor } from '../registry/types.ts';

const { countAdvancedSet, PropPanel, persistAdvancedOpenState, readAdvancedOpenState } =
  await import('./PropPanel.tsx');
const { getAutoFocusedPropName } = await import('../utils/editor-strings.ts');

// ---------------------------------------------------------------------------
// localStorage fake — the read/write helpers swallow throws and treat
// undefined `localStorage` as "no storage". Replace the global per test.
// ---------------------------------------------------------------------------

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
  // Cast the shape — the helpers only call getItem / setItem.
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

// ---------------------------------------------------------------------------
// Descriptor fixtures — minimum surface PropPanel reads.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Static markup — Advanced section presence + count badge
// ---------------------------------------------------------------------------

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
    // The trigger label is "Advanced".
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

    // 0 set → no badge
    const htmlZero = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(htmlZero).not.toContain('data-prop-panel-advanced-count');

    // 2 set (loading away from default + srcset present)
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
    // PropDefBoolean does not declare an autoFocus field. The
    // helper deliberately checks `type === 'string'` to avoid TS escape
    // hatches accidentally surfacing a non-string focus target.
    const props: PropDef[] = [
      // biome-ignore lint/suspicious/noExplicitAny: synthetic shape — autoFocus only valid on string in the type
      { name: 'count', type: 'number', required: false, autoFocus: true } as any,
      { name: 'src', type: 'string', required: true, autoFocus: true },
    ];
    expect(getAutoFocusedPropName(props)).toBe('src');
  });

  test('skips advanced props — would be inside collapsed CollapsibleContent on mount', () => {
    // Defensive guard: a prop with `advanced: true` lives inside the
    // Collapsible (closed by default), so its `<Input>` is not visible on
    // mount. Honoring `autoFocus` on it would tell the browser to focus a
    // hidden element. The helper skips advanced props so the next
    // common-tier autoFocus prop wins, or null if none.
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
    // UX research found users skipping the icon-only Upload button
    // entirely and falling back to URL-paste. The label now lives in
    // visible body text, which (per WCAG 4.1.2 Name, Role, Value +
    // ARIA's name-from-content computation) doubles as the assistive-
    // tech accessible name and as the discoverable affordance for
    // sighted users. Asserting on the visible text rather than
    // `aria-label` locks in BOTH guarantees from one contract: a
    // regression that swaps back to icon-only would fail this
    // expectation before the screen-reader gap re-opens.
    const d = makeCanonicalDescriptor('img', [
      { name: 'src', type: 'string', required: true, accept: ['image/png'] },
    ]);
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    // Visible text inside the button — substring match tolerates the
    // inline `<svg>` icon that renders before the label.
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
    // Marker is rendered for the first matching prop only.
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

// ---------------------------------------------------------------------------
// Real-registry narrowing: WikiEmbed* compats expose only [alias]; canonical
// `<img>` exposes the full htmlImgProps surface. Pulls the metadata from the
// shipped `builtInComponents` (not a stub) so the test catches drift between
// the descriptor's authored prop list and what PropPanel renders.
// ---------------------------------------------------------------------------

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
    // No other prop control IDs from htmlImgProps appear.
    expect(html).not.toContain('id="prop-src"');
    expect(html).not.toContain('id="prop-alt"');
    expect(html).not.toContain('id="prop-width"');
    expect(html).not.toContain('id="prop-height"');
    expect(html).not.toContain('id="prop-srcset"');
    expect(html).not.toContain('id="prop-sizes"');
    expect(html).not.toContain('id="prop-loading"');
    expect(html).not.toContain('id="prop-title"');
    // Single string prop is non-advanced → no Advanced collapsible.
    expect(html).not.toContain('data-prop-panel-advanced-trigger');
    // Exactly one `id="prop-..."` control rendered.
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
    // Pre-open the Advanced collapsible so SSR includes the advanced controls
    // in markup. Radix Collapsible omits closed-content children from SSR.
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('img', true);
      return renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />);
    });
    // Common-tier props are always rendered. `align` lives on the
    // descriptor but is `hidden: true` — the bubble menu's
    // `ImageAlignButtons` owns the alignment surface, so PropPanel
    // skips the redundant Select. The hidden-filter contract is what
    // makes that consolidation load-bearing; pinning both the absence
    // of `id="prop-align"` AND the total prop count guards against an
    // accidental flag drop reintroducing the third surface.
    expect(html).toContain('id="prop-src"');
    expect(html).toContain('id="prop-alt"');
    expect(html).not.toContain('id="prop-align"');
    // Advanced collapsible exists and is open.
    expect(html).toContain('data-prop-panel-advanced-trigger');
    // Advanced controls render inside the open collapsible.
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
    // Confirms WikiEmbed narrowing didn't accidentally apply to the canonical.
    // 12 props rendered (2 common + 10 advanced). `align` is declared
    // but `hidden: true`, so PropPanel skips it.
    const propIds = html.match(/id="prop-[^"]+"/g) ?? [];
    expect(propIds.length).toBe(12);
  });

  test('canonical video descriptor: align is hidden from PropPanel (bubble-menu owns it)', () => {
    // Parallel guard to the img test above. The registry
    // `video.align mirrors img.align` test pins structural equality of
    // the two PropDefs — which catches the `hidden: true` flag drifting
    // off video while it stays on img — but doesn't exercise PropPanel's
    // rendering path. If PropPanel's hidden-prop filter were ever scoped
    // to specific descriptor names (or a regression bypassed it for
    // video), only this layer would catch it.
    const d = findBuiltIn('video');
    const html = withFakeStorage(() => {
      persistAdvancedOpenState('video', true);
      return renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />);
    });
    expect(html).toContain('id="prop-src"');
    expect(html).not.toContain('id="prop-align"');
  });

  test('canonical Embed descriptor: align is hidden from PropPanel (bubble-menu owns it)', () => {
    // Same contract as the img + video guards above. The registry
    // `Embed.align mirrors img.align` test covers structural equality;
    // this test exercises PropPanel's actual rendering of Embed so an
    // Embed-specific filter bypass would fail loud rather than ship.
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

// `CodeMirrorPropInput` mounts CM6 imperatively in a `useEffect` —
// `renderToString` only emits the initial wrapper `<div>`, not the
// editor surface itself, but that's exactly the structural anchor we
// want to guard. The wrapper carries `data-prop-codemirror=""` and
// `data-prop-language="<lang>"` markers; their presence proves the
// CodeMirror branch fired (instead of falling through to the plain
// `<Input>`). Catches silent regression to the single-line input if
// someone removes `propDef.language` from `built-ins.ts` or breaks the
// `if (propDef.language)` guard in PropPanel.
describe('PropPanel — CodeMirror branch (string props with `language`)', () => {
  test('Math.formula renders the CodeMirror wrapper with `data-prop-language="latex"`', () => {
    const d = findBuiltIn('Math');
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    expect(html).toContain('data-prop-codemirror=""');
    expect(html).toContain('data-prop-language="latex"');
    // The wrapper still carries the `id={prop-formula}` so PropPanel's
    // `<label htmlFor={stringId}>` aligns visually (the actual ARIA name
    // lands on `view.contentDOM` via aria-labelledby after mount).
    expect(html).toContain('id="prop-formula"');
  });

  test('MermaidFence.chart is hidden — PropPanel renders no CodeMirror surface for it', () => {
    // `MermaidFence.chart` is marked `hidden: true` in the descriptor so
    // the PropPanel skips it entirely (no input, no label, no CodeMirror
    // wrapper, no error region). Authors edit Mermaid via the dedicated
    // fullscreen "Edit source" pen-icon modal or by editing the
    // ```mermaid fence directly in source mode — the inline panel would
    // duplicate the source-modal flow in a narrower popover.
    //
    // Sibling assertions: `registry.test.ts` pins `chart.hidden === true`
    // at the descriptor layer and `hasEditableProps === false` for the
    // whole descriptor (which is what suppresses the gear icon in
    // `JsxComponentView`). This test pins the rendered consequence — no
    // chart-related markup escapes the PropPanel for MermaidFence.
    const d = findBuiltIn('MermaidFence');
    const html = withFakeStorage(() =>
      renderToString(<PropPanel descriptor={d} values={{}} onChange={() => {}} />),
    );
    // `chart` is MermaidFence's only prop and it's `hidden: true` —
    // PropPanel filters it out, finds the editable-prop set empty, and
    // returns `null` early. `renderToString(null)` produces the empty
    // string. Asserting against `''` directly catches a future regression
    // where someone adds a second non-hidden prop to MermaidFence (the
    // `not.toContain` checks below would still pass in that case).
    expect(html).toBe('');
    expect(html).not.toContain('id="prop-chart"');
    expect(html).not.toContain('data-prop-language="mermaid"');
  });
});

// CSS-length validation rendered inline for descriptor string props
// flagged with `cssLengthInput: true` (Embed.width / Embed.height). The
// validator itself is pinned by `utils/validate-css-length.test.ts`;
// this asserts the rendered HTML routes through the new PropPanel branch
// — wrapper marker, placeholder hint, `aria-invalid`/`aria-describedby`
// wiring, inline error chrome with polite live-region, and that valid
// values produce no error markup.
//
// Embed.width / Embed.height are both flagged `advanced: true` so they
// live inside the Advanced collapsible (closed by default). The render
// helper below pre-seeds the panel's localStorage open-state via
// `persistAdvancedOpenState('Embed', true)` so the SSR output includes
// the width/height markup. Matches the `persistAdvancedOpenState`
// round-trip unit test.
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
    // `aria-live="polite"`, NOT `role="alert"` — avoids interrupting
    // the screen reader on every keystroke while the validator's
    // intermediate states flicker.
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

// Media URL validation rendered inline next to the input. Pinned at the
// PropPanel boundary (the validator itself is pinned by
// `utils/validate-media-url.test.ts`); this asserts the rendered HTML
// includes the inline error + the a11y wiring + the placeholder that
// describes accepted URL shapes whenever a string prop carries `accept`.
describe('PropPanel — media URL validation', () => {
  test('video src with YouTube URL is accepted (Video dispatches to iframe — no error)', () => {
    // YouTube is the one embed provider Video.tsx dispatches natively
    // (via `parseYouTubeUrl` → `<LiteYouTubeEmbed>`), so the PropPanel
    // must not reject the paste. Vimeo / Loom keep the error path
    // (covered by sibling tests below).
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
    // Input itself is still rendered with the user's value.
    expect(html).toContain('id="prop-src"');
    expect(html).toContain('https://www.youtube.com/watch?v=rekaSOwGMu0');
  });

  test('video preload hides on YouTube URLs (no iframe equivalent)', () => {
    const d = findBuiltIn('video');
    // Open the advanced section so all advanced props render in SSR.
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
    // Other advanced props still render (sanity that we didn't accidentally
    // drop the whole advanced section).
    expect(html).toContain('id="prop-controls"');
    expect(html).toContain('id="prop-autoplay"');
    expect(html).toContain('id="prop-loop"');
    expect(html).toContain('id="prop-muted"');
    // `preload` is the lone outlier — its `hideWhen` returns true on
    // YouTube URLs because there's no lite-embed / iframe equivalent
    // (the facade already defers loading until click).
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
    // Vimeo joined YouTube as a recognized embed dispatch — Video.tsx
    // routes recognized Vimeo URLs through `@u-wave/react-vimeo` (via
    // `isVimeoUrl`), so the PropPanel must not reject the paste. Loom
    // keeps the error path (covered by the sibling test below).
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
    // Sanity: other advanced props still render so the section opens.
    expect(html).toContain('id="prop-autoplay"');
    expect(html).toContain('id="prop-muted"');
    expect(html).toContain('id="prop-loop"');
    // Four Vimeo-specific hides:
    //   - `controls` — Vimeo PRO/Business-only at the service layer;
    //     free accounts silently ignore `controls=0`. Hiding the
    //     toggle keeps the PropPanel from offering authoring intent we
    //     can't reliably deliver.
    //   - `preload` — no embed equivalent; the SDK manages preload.
    //   - `poster` — Vimeo serves its own thumbnail; no override hook.
    //   - `playsinline` — Vimeo's lib reads it only at iframe-mount
    //     time (no setter API exists in the SDK); toggling post-mount
    //     does nothing visible. Vimeo's default is already inline.
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
    // Loom joined YouTube + Vimeo as a recognized embed dispatch —
    // Video.tsx routes recognized Loom URLs through the LoomEmbed
    // sub-component (`isLoomUrl`), so the PropPanel must not reject
    // the paste.
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
    // Sanity: other advanced props still render so the section opens.
    expect(html).toContain('id="prop-autoplay"');
    expect(html).toContain('id="prop-muted"');
    expect(html).toContain('id="prop-width"');
    expect(html).toContain('id="prop-height"');
    expect(html).toContain('id="prop-title"');
    // Five Loom-specific hides:
    //   - `controls` — Loom always shows its top bar; no URL toggle.
    //   - `poster` — Loom serves its own thumbnail; no override.
    //   - `preload` — no embed equivalent.
    //   - `playsinline` — not applicable to Loom's iframe.
    //   - `loop` — Loom doesn't expose a loop URL param.
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
    // Image kind gets the generic message, not the video "embeds" promise.
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
      // poster is advanced — open the collapsible so SSR includes it.
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
    // poster carries image MIME accept → image-kind message, NOT the
    // video "embeds" variant. Pins the kind routing against a regression
    // that changes poster's accept to a video MIME set.
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
    // Sanity: advanced section is open + other advanced props still render.
    expect(html).toContain('id="prop-collapsible"');
    expect(html).toContain('id="prop-icon"');
    // defaultOpen is hidden because collapsible !== true.
    expect(html).not.toContain('id="prop-defaultOpen"');
    expect(html).not.toContain('data-prop-name="defaultOpen"');
  });

  test('defaultOpen is hidden when collapsible is absent from values', () => {
    // The omitted-key path is the most common real-world case — a freshly
    // inserted Callout has no `collapsible` key in `values` until the user
    // toggles it. Pinned separately from the explicit-false case so a future
    // refactor to `values.collapsible === false` (more "explicit"
    // false-check) can't silently break the undefined path.
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
    // Sanity: the icon prop's row is rendered (advanced section open).
    expect(html).toContain('id="prop-icon"');
    // IconPickerInput markers — input carries `data-icon-picker-input`,
    // trigger button carries `data-icon-picker-trigger`. If the bare
    // `<Input>` branch fired instead, neither marker would appear.
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
    // ColorPickerInput markers — input + trigger + the native picker
    // always render. The swatch + clear button gate on value (see the
    // next test).
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

// runUpload unit tests were removed — Bun on Linux fires its
// unhandled-rejection observer for any rejected promise constructed in
// the same `mock.module()` scope (regardless of rejection shape: string,
// object, Error, throw-inside-async-body, Promise.reject with synchronous
// .catch pre-attach, or process.on('unhandledRejection') absorbing
// handler — all five tried, all five failed). The observer's event
// bleeds into the next test file's `##[group]` boundary
// (image-upload/upload-file.test.ts) and reports every test there as
// failed, regardless of whether the await/then chain actually catches
// the rejection. The function is 8 lines of standard try/catch + toast;
// runtime exercise via the PropPanel UI provides equivalent coverage at
// a layer Bun's observer doesn't intermediate.

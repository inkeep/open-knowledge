import { describe, expect, test } from 'bun:test';
import { emitMdxJsx } from '../markdown/serialize-helpers.ts';
import { builtInComponents, createRegistry, wildcardMeta } from './index.ts';
import type { JsxComponentMeta } from './types.ts';

describe('createRegistry', () => {
  test('returns the 14 canonical + 9 compat descriptors + wildcard', () => {
    // 14 canonicals (Callout, Image, Video, Audio, Accordion, Math,
    // MermaidFence, Pdf, File, Tabs, Tab, Embed, Mirror, MirrorSource)
    // + 9 compats (GFMCallout, CommonMarkImage, HtmlDetailsAccordion,
    // WikiEmbedImage, WikiEmbedVideo, WikiEmbedAudio, WikiEmbedFile,
    // DollarMath, MathFence) + '*' wildcard.
    // Compats are registered for parse + render but filtered out of the
    // slash menu; they preserve source-form fidelity through round-trip
    // edits.
    //
    // WikiEmbedPdf is not registered — `![[doc.pdf]]` dispatches to
    // WikiEmbedFile instead. Mirror + MirrorSource cover master/copy block
    // transclusion. The Mermaid canonical is named `MermaidFence`
    // (fence-only authoring) — `Mermaid` is intentionally NOT a
    // registered descriptor name, so legacy `<Mermaid />` JSX falls
    // through to the wildcard.
    const registry = createRegistry();
    const entries = [...registry.entries()];
    expect(entries.length).toBe(24);
  });

  test('get returns registered component by name', () => {
    const registry = createRegistry();
    const callout = registry.get('Callout');
    expect(callout).toBeDefined();
    expect(callout?.name).toBe('Callout');
    expect(callout?.hasChildren).toBe(true);
    expect(callout?.props.length).toBeGreaterThan(0);
    expect(callout?.category).toBe('content');
  });

  test('get returns undefined for unregistered names', () => {
    const registry = createRegistry();
    expect(registry.get('DataViz')).toBeUndefined();
  });

  test('getOrWildcard returns wildcard meta for unregistered names', () => {
    const registry = createRegistry();
    const unknown = registry.getOrWildcard('DataViz');
    expect(unknown.name).toBe('*');
    expect(unknown.hasChildren).toBe(true);
    expect(unknown.props.length).toBe(0);
  });

  test('registry.set() followed by get() picks up new descriptor (M3 hot-add)', () => {
    const registry = createRegistry();

    // Before: DataViz is unregistered
    expect(registry.get('DataViz')).toBeUndefined();
    expect(registry.getOrWildcard('DataViz').name).toBe('*');

    // Hot-add
    const dataVizMeta: JsxComponentMeta = {
      name: 'DataViz',
      surface: 'canonical',
      hasChildren: true,
      props: [
        { name: 'chartType', type: 'enum', enumValues: ['bar', 'line', 'pie'], required: true },
      ],
      category: 'content',
      description: 'Data visualization chart',
      serialize: (node, ctx) => emitMdxJsx('DataViz', node, ctx),
    };
    registry.set('DataViz', dataVizMeta);

    // After: DataViz returns the new descriptor
    const result = registry.get('DataViz');
    expect(result).toBeDefined();
    expect(result?.name).toBe('DataViz');
    expect(result?.props.length).toBe(1);
    expect(result?.props[0].name).toBe('chartType');
  });

  test("wildcard has name '*', hasChildren:true, empty props", () => {
    expect(wildcardMeta.name).toBe('*');
    expect(wildcardMeta.hasChildren).toBe(true);
    expect(wildcardMeta.props).toEqual([]);
  });

  test('registry.has returns true for registered, false for unknown', () => {
    const registry = createRegistry();
    expect(registry.has('Callout')).toBe(true);
    expect(registry.has('img')).toBe(true);
    expect(registry.has('video')).toBe(true);
    expect(registry.has('audio')).toBe(true);
    expect(registry.has('Accordion')).toBe(true);
    expect(registry.has('Math')).toBe(true);
    expect(registry.has('MermaidFence')).toBe(true);
    // `<Mermaid />` JSX has no descriptor (canonical is named
    // `MermaidFence`) — falls through to the wildcard via getOrWildcard.
    expect(registry.has('Mermaid')).toBe(false);
    expect(registry.has('Pdf')).toBe(true);
    expect(registry.has('File')).toBe(true);
    expect(registry.has('Tabs')).toBe(true);
    expect(registry.has('Tab')).toBe(true);
    expect(registry.has('Embed')).toBe(true);
    expect(registry.has('Mirror')).toBe(true);
    expect(registry.has('MirrorSource')).toBe(true);
    expect(registry.has('*')).toBe(true);
    // Lowercase media canonicals — capitalized forms now fall through to the
    // wildcard. User content authored before the pivot would render with
    // generic chrome but isn't registered as a fresh-insert canonical.
    expect(registry.has('Image')).toBe(false);
    expect(registry.has('Video')).toBe(false);
    expect(registry.has('Audio')).toBe(false);
    // Other unregistered descriptors fall through to wildcard via getOrWildcard.
    expect(registry.has('Steps')).toBe(false);
    expect(registry.has('DataViz')).toBe(false);
  });
});

describe('builtInComponents manifest', () => {
  test('contains 14 canonical + 9 compat entries (5-pack + Math + MermaidFence + Pdf + File + Tabs + Tab + Embed + Mirror + MirrorSource canonicals; source-form preservation + math syntax + wiki-embed compats; Mermaid is fence-only)', () => {
    expect(builtInComponents.length).toBe(23);
    const canonical = builtInComponents.filter((m) => m.surface === 'canonical');
    const compat = builtInComponents.filter((m) => m.surface === 'compat');
    expect(canonical.length).toBe(14);
    expect(compat.length).toBe(9);
  });

  test('all entries have required fields', () => {
    for (const meta of builtInComponents) {
      expect(meta.name).toBeTruthy();
      expect(typeof meta.hasChildren).toBe('boolean');
      expect(Array.isArray(meta.props)).toBe(true);
    }
  });

  test('all canonical entries have description and searchTerms (slash-menu surface)', () => {
    // Compat descriptors are filtered out of the slash menu, so searchTerms
    // (which power slash-menu discoverability) are only required on canonicals.
    // Description is required on both — surfaces in agent discovery / MCP.
    for (const meta of builtInComponents) {
      expect(meta.description).toBeTruthy();
      if (meta.surface === 'canonical') {
        expect(Array.isArray(meta.searchTerms)).toBe(true);
        expect(meta.searchTerms?.length).toBeGreaterThan(0);
      }
    }
  });

  test('every enum PropDef defaultValue is in enumValues (Mi1 manifest-drift guard)', () => {
    // PropDefEnum.defaultValue is typed loose (`string`),
    // not as `enumValues[number]`, so a typo'd default would compile but
    // ship as a runtime-invalid manifest entry. A type-generic refactor
    // would propagate through every PropDef-array authoring site; this
    // test-time guard catches the same drift class with no source-shape
    // change. Add new descriptors with `defaultValue` that exists in
    // their `enumValues` — anything else is a manifest defect.
    for (const meta of builtInComponents) {
      for (const prop of meta.props) {
        if (prop.type !== 'enum') continue;
        if (prop.defaultValue === undefined) continue;
        expect(
          prop.enumValues,
          `${meta.name}.${prop.name} defaultValue '${prop.defaultValue}' must appear in enumValues ${JSON.stringify(prop.enumValues)}`,
        ).toContain(prop.defaultValue);
      }
    }
  });

  test('only Tabs registers emptyChildName (single compound parent in the canonical pack)', () => {
    // The original compound-components bridge was retired
    // (precedent #29 retracted on its old form). The Tabs
    // revival reintroduced exactly one compound parent — `Tabs → Tab` —
    // wired via JsxComponentView's standard `+ Add child` pill. Insertion
    // routes through `createChildNode('Tab')` so the inserted PM shape
    // matches slash-seeded starter Tabs (source-roundtrip safe).
    //
    // The `.jsx-empty-child-placeholder` affordance fires
    // when a Tabs is emptied (both seeded tabs deleted). The
    // component-blocks a11y e2e suite exercises the
    // keyboard-activation invariant against that placeholder. If a SECOND
    // compound parent lands, extend the expected set here AND verify
    // that suite still covers the new descriptor's empty-state UX.
    const containers = builtInComponents.filter((m) => m.emptyChildName);
    const names = containers.map((c) => `${c.name}→${c.emptyChildName}`).sort();
    expect(
      names,
      `Unexpected compound descriptor set: ${names.join(', ')}. Either update this assertion (and extend A11Y07 coverage) or revert the emptyChildName addition.`,
    ).toEqual(['Tabs→Tab']);
  });

  test('Tabs descriptor prop surface is exactly `id` (the deep-link anchor)', () => {
    // The strip's selection state is ephemeral React state, intentionally NOT
    // a PM-stored prop — see Tabs.tsx header. So the descriptor's only
    // user-facing prop is `id` (string, optional, advanced, no autoFocus).
    // Adding a public prop here that affects rendering MUST come with a
    // corresponding wiring through Tabs.tsx + serialization + showcase.
    const tabs = builtInComponents.find((m) => m.name === 'Tabs');
    expect(tabs).toBeDefined();
    expect(tabs?.hasChildren).toBe(true);
    expect(tabs?.emptyChildName).toBe('Tab');
    expect(tabs?.props.map((p) => p.name)).toEqual(['id']);
    const idProp = tabs?.props.find((p) => p.name === 'id');
    expect(idProp?.type).toBe('string');
    expect(idProp?.required).toBe(false);
    expect(idProp?.advanced).toBe(true);
  });

  test('Tab descriptor prop surface — `label` (required + autoFocus) + `id` (advanced)', () => {
    // `label`'s autoFocus drives the PropPanel UX: when a fresh Tab is
    // inserted via the `+ Add Tab` pill, the strip-side label input takes
    // focus so the user can type a meaningful name immediately. Removing
    // autoFocus silently regresses the insertion-to-naming flow.
    // `required: true` matches Tabs.tsx's safeLabel fallback contract —
    // an empty label is interpreted as "use Tab N" but the descriptor
    // surface treats it as required so the PropPanel marks it.
    const tab = builtInComponents.find((m) => m.name === 'Tab');
    expect(tab).toBeDefined();
    expect(tab?.hasChildren).toBe(true);
    expect(tab?.emptyChildName).toBeUndefined();
    expect(tab?.props.map((p) => p.name).sort()).toEqual(['id', 'label']);
    const labelProp = tab?.props.find((p) => p.name === 'label');
    expect(labelProp?.type).toBe('string');
    expect(labelProp?.required).toBe(true);
    expect(labelProp?.autoFocus).toBe(true);
    expect(labelProp?.defaultValue).toBe('Tab');
    const idProp = tab?.props.find((p) => p.name === 'id');
    expect(idProp?.advanced).toBe(true);
  });

  test('Callout has 15 first-class type enum values (GFM 5 + Obsidian-parity 10)', () => {
    // GFM 5 (`note`, `tip`, `important`, `warning`, `caution`) + 10
    // Obsidian-parity types promoted from aliases to first-class
    // (`abstract`, `info`, `todo`, `success`, `question`, `failure`,
    // `danger`, `bug`, `example`, `quote`). Rarer aliases (e.g.
    // `summary`, `cite`, `error`) still fold via the parser's alias map
    // — they collapse into the new first-class types, not the GFM 5.
    // Precedent #9 schema-add-only: the enum is widened, never narrowed.
    const callout = builtInComponents.find((m) => m.name === 'Callout');
    expect(callout).toBeDefined();
    if (!callout) return;
    const typeProp = callout.props.find((p) => p.name === 'type');
    expect(typeProp).toBeDefined();
    expect(typeProp?.type).toBe('enum');
    if (typeProp?.type === 'enum') {
      expect([...typeProp.enumValues].sort()).toEqual(
        [
          'abstract',
          'bug',
          'caution',
          'danger',
          'example',
          'failure',
          'important',
          'info',
          'note',
          'question',
          'quote',
          'success',
          'tip',
          'todo',
          'warning',
        ].sort(),
      );
      expect(typeProp.defaultValue).toBe('note');
    }
  });

  test('Callout exposes the 7-prop FR-1 surface', () => {
    // `collapsible` + `defaultOpen` were added within the GFM 5-type scope.
    // Together with `type`, `title`, `icon`, `color`, and `children` that's
    // the full prop surface — order-insensitive; a future PropPanel reshuffle
    // should not break this guard.
    const callout = builtInComponents.find((m) => m.name === 'Callout');
    expect(callout).toBeDefined();
    if (!callout) return;
    const propNames = callout.props.map((p) => p.name).sort();
    expect(propNames).toEqual(
      ['children', 'collapsible', 'color', 'defaultOpen', 'icon', 'title', 'type'].sort(),
    );
  });

  test('img exposes the 13-prop HTML-native surface (3 common + 10 advanced)', () => {
    // Lowercase media canonical pivot. Drops the OK-specific `caption` and
    // `zoom` props from the descriptor — caption belongs on a future Frame
    // wrapper; zoom is always-on inside the Image React component.
    // Common: src + alt + align. Advanced: width + height + srcset + sizes +
    // loading + title + decoding + fetchpriority + crossorigin +
    // referrerpolicy.
    // Order-insensitive — a future reshuffle should not break this.
    const img = builtInComponents.find((m) => m.name === 'img');
    expect(img).toBeDefined();
    if (!img) return;
    const propNames = img.props.map((p) => p.name).sort();
    expect(propNames).toEqual(
      [
        'src',
        'alt',
        'align',
        'width',
        'height',
        'srcset',
        'sizes',
        'loading',
        'title',
        'decoding',
        'fetchpriority',
        'crossorigin',
        'referrerpolicy',
      ].sort(),
    );
  });

  test('img.align is a 3-value enum with center default, hidden from PropPanel', () => {
    // Alignment lives on the descriptor so it serializes through MDX as
    // `<img align="left" />` and round-trips. `center` is the visual +
    // descriptor default; `omitOnDefault: true` keeps existing images
    // (with no explicit `align`) byte-stable on save. The `hidden: true`
    // flag is the load-bearing mechanism that consolidates alignment
    // onto the bubble menu's `ImageAlignButtons` — without it,
    // PropPanel would render a Select dropdown that would sit alongside
    // the bubble-menu trio and present a redundant second control.
    const img = builtInComponents.find((m) => m.name === 'img');
    const align = img?.props.find((p) => p.name === 'align');
    expect(align).toBeDefined();
    if (align?.type === 'enum') {
      expect([...align.enumValues].sort()).toEqual(['center', 'left', 'right'].sort());
      expect(align.defaultValue).toBe('center');
      expect(align.omitOnDefault).toBe(true);
      // NOT advanced — alignment is a frequent tweak; the `advanced`
      // taxonomy is orthogonal to the `hidden` flag below.
      expect(align.advanced).toBeUndefined();
      // Pin the bubble-menu-only contract. If this flag is dropped in
      // a future refactor, PropPanel's hidden-prop filter
      // (`!('hidden' in p && p.hidden)`) lets the Select re-appear and
      // the consolidation regresses silently.
      expect(align.hidden).toBe(true);
      // Pin the enum order — `center` must be first so the descriptor's
      // declared default matches the wrapper-level CSS's "no explicit
      // alignment" rendering.
      expect(align.enumValues[0]).toBe('center');
    }
  });

  test('img.alt is required with no defaultValue (WCAG 1.1.1 — must be a deliberate decision)', () => {
    // Pins the source-of-truth schema for the tri-state needsConfig predicate:
    // `required: true` means the predicate evaluates the prop at all;
    // omitting `defaultValue` means `getDefaultProps` does NOT stamp `''` on
    // fresh slash-insert, leaving the key absent so the gear nudge fires
    // until the author types alt text OR explicitly writes `alt=""` for the
    // decorative opt-in. Regressing to `required: false` or `defaultValue: ''`
    // silently re-allows shipping images without an alt-text decision —
    // breaks the WCAG-1.1.1 enforcement for the alt-text gear nudge.
    const img = builtInComponents.find((m) => m.name === 'img');
    const alt = img?.props.find((p) => p.name === 'alt');
    expect(alt).toBeDefined();
    expect(alt?.required).toBe(true);
    expect(alt && 'defaultValue' in alt).toBe(false);
  });

  test('CommonMarkImage.alt inherits required:true via htmlImgProps[1] identity-share', () => {
    // CommonMarkImage's prop list reuses the same htmlImgProps[1] object as
    // img's; both descriptors see the same `alt` PropDef instance. A future
    // refactor that breaks the identity-share (e.g., spreads `{...alt}` into
    // a new object) would silently let CommonMark `<img>` ship without a
    // required-flag while JSX `<img>` retains it. Pin the inheritance via
    // `Object.is` so a spread-into-fresh-object preserves the shape but
    // FAILS the identity check loudly — a shape-only assertion would slip.
    const img = builtInComponents.find((m) => m.name === 'img');
    const cmi = builtInComponents.find((m) => m.name === 'CommonMarkImage');
    const imgAlt = img?.props.find((p) => p.name === 'alt');
    const cmiAlt = cmi?.props.find((p) => p.name === 'alt');
    expect(imgAlt).toBeDefined();
    expect(cmiAlt).toBeDefined();
    expect(Object.is(imgAlt, cmiAlt)).toBe(true);
    // Shape pins (defense-in-depth — survive even if identity check is later
    // intentionally relaxed; these are the WCAG-1.1.1 contract regardless).
    expect(cmiAlt?.required).toBe(true);
    expect(cmiAlt && 'defaultValue' in cmiAlt).toBe(false);
  });

  test('CommonMarkImage compat exposes exactly src + alt + title (no align)', () => {
    // The index-stability contract documented in `built-ins.ts`'s
    // `htmlImgProps` index map: `align` was appended at index `[12]` so
    // identity-shared `htmlImgProps[N]` references in
    // `commonMarkImageProps` (indices [0], [1], [7] → src, alt, title)
    // stay stable. CommonMark `![alt](src "title")` syntax has no
    // alignment surface, so the compat must NOT include `align`. A future
    // refactor that moves `align` to an earlier index would silently
    // shift `htmlImgProps[7]` away from `title`, breaking CommonMark
    // image title round-tripping — this test fails loud when that
    // happens.
    const cmi = builtInComponents.find((m) => m.name === 'CommonMarkImage');
    expect(cmi).toBeDefined();
    if (!cmi) return;
    const propNames = cmi.props.map((p) => p.name).sort();
    expect(propNames).toEqual(['alt', 'src', 'title'].sort());
    expect(cmi.props.find((p) => p.name === 'align')).toBeUndefined();
  });

  test('img has `loading` as a 2-value enum with lazy default (advanced-tagged)', () => {
    const img = builtInComponents.find((m) => m.name === 'img');
    const loading = img?.props.find((p) => p.name === 'loading');
    expect(loading).toBeDefined();
    if (loading?.type === 'enum') {
      expect([...loading.enumValues].sort()).toEqual(['eager', 'lazy'].sort());
      expect(loading.defaultValue).toBe('lazy');
      expect(loading.advanced).toBe(true);
    } else {
      throw new Error('img.loading must be an enum');
    }
  });

  test('img drops the `zoom` and `caption` props (Frame v2 will host)', () => {
    // Greenfield pivot: zoom is now always-on inside the Image React
    // component; caption belongs on a compositional Frame wrapper.
    const img = builtInComponents.find((m) => m.name === 'img');
    expect(img?.props.find((p) => p.name === 'zoom')).toBeUndefined();
    expect(img?.props.find((p) => p.name === 'caption')).toBeUndefined();
  });

  test('img stays `isSelfClosing: true` (no children slot)', () => {
    // The CommonMark image bridge requires the canonical descriptor
    // to declare `hasChildren: false` + `isSelfClosing: true` so the
    // promotion path can map paragraph>image into a leaf descriptor cleanly.
    const img = builtInComponents.find((m) => m.name === 'img');
    expect(img?.hasChildren).toBe(false);
    expect(img?.isSelfClosing).toBe(true);
  });

  test('video exposes the 12-prop HTML-native surface (2 common + 10 advanced)', () => {
    // Lowercase media canonical pivot. Adds `width` / `height` (today's
    // canonical lacked them); HTML-attr lowercase names (`autoplay`,
    // `playsinline`) so the rendered MDX matches the spec exactly. `align`
    // is present for image parity (mirror htmlImgProps[12]).
    // Order-insensitive — a future reshuffle should not break this guard.
    const video = builtInComponents.find((m) => m.name === 'video');
    expect(video).toBeDefined();
    if (!video) return;
    const propNames = video.props.map((p) => p.name).sort();
    expect(propNames).toEqual(
      [
        'src',
        'align',
        'controls',
        'autoplay',
        'poster',
        'width',
        'height',
        'title',
        'muted',
        'loop',
        'playsinline',
        'preload',
      ].sort(),
    );
  });

  test('video.align mirrors img.align (PRD-6822 parity)', () => {
    // Video joined the alignment-bearing descriptor set so
    // the chrome-bar buttons and floating-PropPanel anchor behave the
    // same way for video as for img. The contract is "literal parity" —
    // every field on img.align must be mirrored on video.align so the
    // wrapper-level `data-align` write path, the CSS `text-align`
    // rules, and the bubble-menu enum-fallback all see exactly the
    // same PropDef. Read both descriptors and compare structurally
    // rather than hardcoding the shape — a future change to
    // img.align (a fourth enum value, a description tweak, dropping
    // `omitOnDefault`) would otherwise silently drift video.align
    // while this guard stayed green.
    const img = builtInComponents.find((m) => m.name === 'img');
    const video = builtInComponents.find((m) => m.name === 'video');
    const imgAlign = img?.props.find((p) => p.name === 'align');
    const videoAlign = video?.props.find((p) => p.name === 'align');
    expect(imgAlign).toBeDefined();
    expect(videoAlign).toBeDefined();
    // Literal equality — every field (type, enumValues, defaultValue,
    // omitOnDefault, required, description, etc.) must match. No
    // identity-share (the two PropDefs are intentionally distinct
    // objects on their respective `htmlImgProps` / `htmlVideoProps`
    // arrays) — `.toEqual` compares structurally, which is the
    // contract we want. Picks up the `hidden: true` consolidation
    // automatically: if it's dropped from one but not the other, this
    // structural compare fails loudly before the alignment surface drifts.
    expect(videoAlign).toEqual(imgAlign);
  });

  test('Embed.align mirrors img.align (single alignment surface — bubble menu)', () => {
    // Embed joined the alignable descriptor set so an iframe embed
    // composes with the same `text-align` wrapper rule the img / video
    // alignment buttons drive. The literal-equality check pins the
    // `hidden: true` consolidation alongside the enum shape — any drift
    // (drop the flag, change enum order, mutate defaultValue) fails
    // here. Without this pin, an `align` Select could silently re-
    // appear in PropPanel for Embed while img / video stayed clean.
    const img = builtInComponents.find((m) => m.name === 'img');
    const embed = builtInComponents.find((m) => m.name === 'Embed');
    const imgAlign = img?.props.find((p) => p.name === 'align');
    const embedAlign = embed?.props.find((p) => p.name === 'align');
    expect(imgAlign).toBeDefined();
    expect(embedAlign).toBeDefined();
    expect(embedAlign).toEqual(imgAlign);
  });

  test('video has `controls` as a boolean with `true` default', () => {
    // The default matches browser HTML5 authoring intuition — a video
    // inserted via slash-menu renders with controls visible. Authors who
    // want a chrome-less video (background loop, hero autoplay) set
    // controls={false} explicitly.
    const video = builtInComponents.find((m) => m.name === 'video');
    const controls = video?.props.find((p) => p.name === 'controls');
    expect(controls).toBeDefined();
    if (controls?.type === 'boolean') {
      expect(controls.defaultValue).toBe(true);
    } else {
      throw new Error('video.controls must be a boolean');
    }
  });

  test('video has `preload` as a 3-value enum (advanced-tagged)', () => {
    const video = builtInComponents.find((m) => m.name === 'video');
    const preload = video?.props.find((p) => p.name === 'preload');
    expect(preload).toBeDefined();
    if (preload?.type === 'enum') {
      expect([...preload.enumValues].sort()).toEqual(['auto', 'metadata', 'none'].sort());
      expect(preload.advanced).toBe(true);
    } else {
      throw new Error('video.preload must be an enum');
    }
  });

  test('video is a self-closing leaf (no PM children)', () => {
    // HTML5 `<track>` / `<source>` require direct-child placement under
    // `<video>`, but PM NodeViews mandate a wrapper DOM element — the two
    // contracts are structurally incompatible. Authors who need captions /
    // codec fallback write raw `<video>` + `<track>` HTML in MDX, which
    // flows through rawMdxFallback.
    const video = builtInComponents.find((m) => m.name === 'video');
    expect(video?.hasChildren).toBe(false);
    expect(video?.isSelfClosing).toBe(true);
  });

  test('video has no `start` prop (matches Mintlify / Fumadocs)', () => {
    // Runtime seek is not a persisted authoring concern.
    const video = builtInComponents.find((m) => m.name === 'video');
    const start = video?.props.find((p) => p.name === 'start');
    expect(start).toBeUndefined();
  });

  test('audio exposes the 7-prop HTML-native surface (1 common + 6 advanced)', () => {
    // Lowercase media canonical pivot. `controls` is now an explicit prop
    // (default true) — Audio.tsx no longer hardcodes always-on; authors who
    // want a chrome-less audio set controls={false} from the descriptor.
    const audio = builtInComponents.find((m) => m.name === 'audio');
    expect(audio).toBeDefined();
    if (!audio) return;
    const propNames = audio.props.map((p) => p.name).sort();
    expect(propNames).toEqual(
      ['src', 'controls', 'autoplay', 'title', 'muted', 'loop', 'preload'].sort(),
    );
  });

  test('audio has `preload` as a 3-value enum (advanced-tagged)', () => {
    const audio = builtInComponents.find((m) => m.name === 'audio');
    const preload = audio?.props.find((p) => p.name === 'preload');
    expect(preload).toBeDefined();
    if (preload?.type === 'enum') {
      expect([...preload.enumValues].sort()).toEqual(['auto', 'metadata', 'none'].sort());
      expect(preload.advanced).toBe(true);
    } else {
      throw new Error('audio.preload must be an enum');
    }
  });

  test('audio is a self-closing leaf (symmetric with video)', () => {
    const audio = builtInComponents.find((m) => m.name === 'audio');
    expect(audio?.hasChildren).toBe(false);
    expect(audio?.isSelfClosing).toBe(true);
  });

  test('audio has `controls` as a boolean with `true` default (was hardcoded always-on)', () => {
    // Lowercase pivot promotes controls to an explicit prop. Default true
    // preserves the prior always-on behavior for the common case.
    const audio = builtInComponents.find((m) => m.name === 'audio');
    const controls = audio?.props.find((p) => p.name === 'controls');
    expect(controls).toBeDefined();
    if (controls?.type === 'boolean') {
      expect(controls.defaultValue).toBe(true);
    } else {
      throw new Error('audio.controls must be a boolean');
    }
  });

  test('Accordion exposes the 6-prop FR-5 surface', () => {
    // Accordion has a 6-prop shape — standalone
    // (no `variant`; renamed from Toggle). Order-insensitive.
    const accordion = builtInComponents.find((m) => m.name === 'Accordion');
    expect(accordion).toBeDefined();
    if (!accordion) return;
    const propNames = accordion.props.map((p) => p.name).sort();
    expect(propNames).toEqual(['title', 'defaultOpen', 'icon', 'description', 'id', 'name'].sort());
  });

  test('Accordion has `title` as a required string', () => {
    // `title` is the only required prop — ensures a freshly-inserted Accordion
    // always has a visible affordance in the summary.
    const accordion = builtInComponents.find((m) => m.name === 'Accordion');
    const title = accordion?.props.find((p) => p.name === 'title');
    expect(title).toBeDefined();
    expect(title?.type).toBe('string');
    expect(title?.required).toBe(true);
  });

  test('Accordion has `defaultOpen` as a boolean with `false` default', () => {
    // Defaults to closed so slash-menu insertions don't immediately dominate
    // page layout. Authors flip true for sections they want expanded up front.
    const accordion = builtInComponents.find((m) => m.name === 'Accordion');
    const defaultOpen = accordion?.props.find((p) => p.name === 'defaultOpen');
    expect(defaultOpen).toBeDefined();
    if (defaultOpen?.type === 'boolean') {
      expect(defaultOpen.defaultValue).toBe(false);
    } else {
      throw new Error('Accordion.defaultOpen must be a boolean');
    }
  });

  test('Accordion has `hasChildren: true` and no `isSelfClosing` (FR-5)', () => {
    // Accordion body is a content hole — the descriptor MUST
    // declare hasChildren: true so the NodeView mounts a NodeViewContent
    // slot. Flipping to self-closing would strip the body on re-serialize.
    const accordion = builtInComponents.find((m) => m.name === 'Accordion');
    expect(accordion?.hasChildren).toBe(true);
    expect(accordion?.isSelfClosing).toBeUndefined();
  });

  test('Accordion has no `variant` prop (D-MF14 — NG30 preserves Notion color-map path)', () => {
    // The research-recommended 7-prop descriptor included a `variant`
    // enum absorbing Notion's color map (default/gray/brown/_background) —
    // those come from the de-prioritized Notion audience. Dropping now (when
    // nothing consumes it) avoids permanent lock-in under precedent #9. The
    // Notion color-map absorption path is preserved. Schema-add-only makes
    // extension free later.
    const accordion = builtInComponents.find((m) => m.name === 'Accordion');
    const variant = accordion?.props.find((p) => p.name === 'variant');
    expect(variant).toBeUndefined();
  });

  test('Accordion has no `emptyChildName` (D-MF16 — ships standalone, not compound)', () => {
    // Accordion ships standalone, not as a compound parent. The
    // foundation does NOT require an `<Accordions>` parent wrapper —
    // diverges from Fumadocs's Radix-requires-parent pattern. A future
    // compound tier could serve grouped-UX demand; standalone stays first.
    const accordion = builtInComponents.find((m) => m.name === 'Accordion');
    expect(accordion?.emptyChildName).toBeUndefined();
  });

  test('Math exposes the 3-prop surface', () => {
    const math = builtInComponents.find((m) => m.name === 'Math');
    expect(math).toBeDefined();
    if (!math) return;
    const propNames = math.props.map((p) => p.name).sort();
    expect(propNames).toEqual(['formula', 'id', 'language'].sort());
  });

  test('Math has `formula` as a required string with autoFocus + LaTeX CodeMirror language', () => {
    const math = builtInComponents.find((m) => m.name === 'Math');
    const formula = math?.props.find((p) => p.name === 'formula');
    expect(formula).toBeDefined();
    expect(formula?.type).toBe('string');
    expect(formula?.required).toBe(true);
    if (formula?.type === 'string') {
      expect(formula.autoFocus).toBe(true);
      // PropPanel renders this as a CodeMirror editor with stex (LaTeX)
      // syntax highlighting + line numbers — multi-line `\begin{align}…`
      // and matrix-heavy formulas no longer collapse into a single-line
      // input. See `CodeMirrorPropInput`.
      expect(formula.language).toBe('latex');
    }
  });

  test('Math is a self-closing leaf (no children slot)', () => {
    const math = builtInComponents.find((m) => m.name === 'Math');
    expect(math?.hasChildren).toBe(false);
    expect(math?.isSelfClosing).toBe(true);
  });

  test('Math has no `display` prop', () => {
    const math = builtInComponents.find((m) => m.name === 'Math');
    const display = math?.props.find((p) => p.name === 'display');
    expect(display).toBeUndefined();
  });

  test('MermaidFence exposes the 1-prop fence surface (chart only)', () => {
    // Fence-only authoring: `id` and `theme` are not on the descriptor
    // because they aren't expressible in ` ```mermaid ` fence syntax.
    // The descriptor's serialize emits the fence on dirty save.
    const mermaid = builtInComponents.find((m) => m.name === 'MermaidFence');
    expect(mermaid).toBeDefined();
    if (!mermaid) return;
    const propNames = mermaid.props.map((p) => p.name).sort();
    expect(propNames).toEqual(['chart']);
  });

  test('MermaidFence keeps `chart` in the descriptor schema but hides it from PropPanel', () => {
    // The chart prop stays declared so serialization, MCP `palette`
    // queries, and the build-registry JSDoc extractor keep working off the
    // schema. `hidden: true` is what suppresses the PropPanel UI — and
    // because chart is the descriptor's only prop, the chrome `gear` icon
    // on the node-view falls off too (`hasEditableProps` returns false in
    // `JsxComponentView`). The canonical authoring surface for Mermaid is
    // the dedicated fullscreen "Edit source" pen-icon modal
    // (`CodePreviewEditModal`) — wired off the `editableSource` predicate
    // — plus direct ```mermaid fence editing in source mode.
    const mermaid = builtInComponents.find((m) => m.name === 'MermaidFence');
    const chart = mermaid?.props.find((p) => p.name === 'chart');
    expect(chart).toBeDefined();
    expect(chart?.type).toBe('string');
    expect(chart?.required).toBe(true);
    expect(chart?.hidden).toBe(true);
  });

  test('MermaidFence has no editable props — chrome `gear` icon is suppressed', () => {
    // Mirrors `hasEditableProps` in `JsxComponentView` — every prop is
    // either `hidden` or `type === 'reactnode'`. Locks the gear-icon
    // suppression at the descriptor layer so the node-view doesn't grow
    // an inline PropPanel button that opens an empty popover.
    const mermaid = builtInComponents.find((m) => m.name === 'MermaidFence');
    const editable = mermaid?.props.some(
      (p) => !('hidden' in p && p.hidden) && p.type !== 'reactnode',
    );
    expect(editable).toBe(false);
  });

  test('MermaidFence is a self-closing leaf (no children slot)', () => {
    const mermaid = builtInComponents.find((m) => m.name === 'MermaidFence');
    expect(mermaid?.hasChildren).toBe(false);
    expect(mermaid?.isSelfClosing).toBe(true);
  });

  test('MermaidFence keeps `displayName: "Mermaid"` (user-facing label unchanged)', () => {
    // The descriptor's AST node name is `MermaidFence` (so `<Mermaid />`
    // JSX doesn't match), but the slash menu + PropPanel still show
    // "Mermaid" so the rename is invisible to end users.
    const mermaid = builtInComponents.find((m) => m.name === 'MermaidFence');
    expect(mermaid?.displayName).toBe('Mermaid');
  });

  test('Mirror exposes split-prop self-closing shape (src + anchor)', () => {
    const mirror = builtInComponents.find((m) => m.name === 'Mirror');
    expect(mirror).toBeDefined();
    if (!mirror) return;
    expect(mirror.hasChildren).toBe(false);
    expect(mirror.isSelfClosing).toBe(true);
    const propNames = mirror.props.map((p) => p.name).sort();
    expect(propNames).toEqual(['anchor', 'src']);
    const src = mirror.props.find((p) => p.name === 'src');
    const anchor = mirror.props.find((p) => p.name === 'anchor');
    expect(src?.type).toBe('string');
    expect(src?.required).toBe(true);
    if (src?.type === 'string') {
      expect(src.autoFocus).toBe(true);
    }
    expect(anchor?.type).toBe('string');
    expect(anchor?.required).toBe(true);
  });

  test('MirrorSource exposes container shape (id + children slot)', () => {
    const mirrorSource = builtInComponents.find((m) => m.name === 'MirrorSource');
    expect(mirrorSource).toBeDefined();
    if (!mirrorSource) return;
    expect(mirrorSource.hasChildren).toBe(true);
    // Container components don't declare isSelfClosing (the JSX-emit path
    // emits `<MirrorSource id="…">…</MirrorSource>`, not `<MirrorSource />`).
    expect(mirrorSource.isSelfClosing).toBeUndefined();
    const propNames = mirrorSource.props.map((p) => p.name).sort();
    expect(propNames).toEqual(['children', 'id']);
    const id = mirrorSource.props.find((p) => p.name === 'id');
    expect(id?.type).toBe('string');
    expect(id?.required).toBe(true);
    if (id?.type === 'string') {
      expect(id.autoFocus).toBe(true);
    }
  });

  test('MermaidFence serializes to a ` ```mermaid ` code fence (not JSX)', () => {
    // The fence-only contract: the canonical descriptor emits a `code`
    // mdast node with `lang: 'mermaid'` so remark-stringify produces a
    // ` ```mermaid …``` ` fence on dirty save. Pristine bytes are
    // preserved by Phase B's position-slice walker (source-raw).
    const mermaid = builtInComponents.find((m) => m.name === 'MermaidFence');
    expect(mermaid).toBeDefined();
    if (!mermaid) return;
    // biome-ignore lint/suspicious/noExplicitAny: serialize signature is heterogeneous across descriptors
    const out: any = mermaid.serialize(
      {
        type: { name: 'jsxComponent' },
        attrs: { componentName: 'MermaidFence', props: { chart: 'graph TD; A-->B;' } },
      } as never,
      { all: () => [] } as never,
    );
    expect(out.type).toBe('code');
    expect(out.lang).toBe('mermaid');
    expect(out.value).toBe('graph TD; A-->B;');
  });

  test('each name is unique', () => {
    const names = builtInComponents.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('category is always a valid value', () => {
    const validCategories = new Set(['content', 'layout', 'media', 'data']);
    for (const meta of builtInComponents) {
      if (meta.category) {
        expect(validCategories.has(meta.category)).toBe(true);
      }
    }
  });

  test("no name collides with wildcard '*'", () => {
    const names = builtInComponents.map((m) => m.name);
    expect(names).not.toContain('*');
  });
});

describe('placeholder contract — media descriptor src prop invariants', () => {
  // The placeholder feature depends on a precise contract on each media
  // descriptor's `src` prop. If a future change drops `defaultValue: ''`, removes
  // `autoFocus: true`, or marks `src` as `advanced`, the placeholder pill
  // silently stops rendering and users get the broken-source icon back.
  // Downstream tests (the resolve-descriptor-placeholder unit test, e2e) would
  // catch the regression eventually, but a manifest-level guard here flags
  // it at `bun test` time with descriptor-named error messages.
  for (const name of ['img', 'video', 'audio', 'Pdf', 'File', 'Embed'] as const) {
    test(`${name}.src satisfies the placeholder contract`, () => {
      const meta = builtInComponents.find((m) => m.name === name);
      expect(meta).toBeDefined();
      const src = meta?.props.find((p) => p.name === 'src');
      expect(src, `${name} must declare a src prop`).toBeDefined();
      if (!src || src.type !== 'string') return;
      expect(
        src.defaultValue,
        `${name}.src must have defaultValue '' so slash-insert pre-populates the placeholder predicate's =='' check`,
      ).toBe('');
      expect(
        src.autoFocus,
        `${name}.src must have autoFocus: true so getAutoFocusedPropName returns 'src'`,
      ).toBe(true);
      expect(
        'advanced' in src && src.advanced === true,
        `${name}.src must NOT be advanced — getAutoFocusedPropName skips advanced props, so an advanced src silently disables the placeholder pill`,
      ).toBe(false);
    });
  }
});

describe('common/advanced split per descriptor', () => {
  // Locks down the exact prop classification. The
  // non-advanced (default-visible) section is calibrated to props the typical
  // author actually picks (≥20% of inserts). A future change that demotes or
  // promotes a prop must update this test, surfacing the design decision
  // rather than silently changing the PropPanel layout.
  type Split = { common: string[]; advanced: string[] };
  const expected: Record<string, Split> = {
    img: {
      // `align` is appended at the end of `htmlImgProps` (so existing
      // identity-shared `htmlImgProps[N]` references in
      // `commonMarkImageProps` stay stable) but is NOT marked advanced
      // — alignment is a frequent author-tweak that surfaces in the
      // bubble-menu and so should appear flat in the PropPanel too.
      common: ['src', 'alt', 'align'],
      advanced: [
        'width',
        'height',
        'srcset',
        'sizes',
        'loading',
        'title',
        'decoding',
        'fetchpriority',
        'crossorigin',
        'referrerpolicy',
      ],
    },
    video: {
      // `align` is in common — same shape as img + Embed
      // so chrome-bar alignment buttons fire and PropPanel surfaces the
      // dropdown alongside `src` in the basic form.
      common: ['src', 'align'],
      advanced: [
        'controls',
        'autoplay',
        'poster',
        'width',
        'height',
        'title',
        'muted',
        'loop',
        'playsinline',
        'preload',
      ],
    },
    audio: {
      common: ['src'],
      advanced: ['controls', 'autoplay', 'title', 'muted', 'loop', 'preload'],
    },
    Callout: {
      common: ['type', 'title'],
      advanced: ['icon', 'color', 'collapsible', 'defaultOpen'],
    },
    Accordion: {
      common: ['title', 'defaultOpen'],
      advanced: ['icon', 'description', 'id', 'name'],
    },
    Math: {
      common: ['formula'],
      advanced: ['id', 'language'],
    },
    MermaidFence: {
      // Fence-only: single `chart` prop. `id` and `theme` aren't
      // expressible in fence syntax, so they don't exist on the descriptor.
      common: ['chart'],
      advanced: [],
    },
    Pdf: {
      common: ['src'],
      advanced: ['title', 'anchor'],
    },
    File: {
      // `File` is intentionally a one-prop canonical. The user-facing
      // shape is the `![[file.ext]]` wikilink (consumed by `WikiEmbedFile`
      // compat → translates to renderer); JSX `<File>` is filtered from
      // the slash menu and exists only as the dispatch target so the
      // compat has somewhere to render through. Display props (`name` /
      // `size`) are passed by the compat at translateProps time, NOT
      // declared here — declaring them would surface them in PropPanel
      // for hand-authored `<File>` and emit serializer noise.
      common: ['src'],
      advanced: [],
    },
    Embed: {
      // `src` (required URL), `title` (a11y label — kept in common
      // because nothing auto-derives it), and `align` (matches the
      // chrome-bar alignment trio) are the typical-author surface.
      // `width` / `height` are advanced because the resize-handle
      // gesture writes them automatically; PropPanel input is the
      // power-user escape hatch.
      common: ['src', 'title', 'align'],
      advanced: ['width', 'height'],
    },
  };
  for (const [name, split] of Object.entries(expected)) {
    test(`${name} common/advanced split matches the typical-author calibration`, () => {
      const meta = builtInComponents.find((m) => m.name === name);
      expect(meta).toBeDefined();
      if (!meta) return;
      const editable = meta.props.filter((p) => p.type !== 'reactnode');
      const common = editable
        .filter((p) => !('advanced' in p && p.advanced === true))
        .map((p) => p.name);
      const advanced = editable
        .filter((p) => 'advanced' in p && p.advanced === true)
        .map((p) => p.name);
      expect(common).toEqual(split.common);
      expect(advanced).toEqual(split.advanced);
    });
  }

  // ─── Schema-flip-drift meta-test (parallel to precedent #47) ─────────
  //
  // The substrate-vocabulary drift guard (precedent #47) catches test
  // fixtures that reference substrate names absent from the registry.
  // This meta-test catches the inverse class: descriptor schema drift
  // that silently regresses the key-absence predicate (precedent #46) by
  // re-introducing `defaultValue: ''` on a required string prop.
  //
  // The tri-state nudge contract requires: required string props that
  // opt into the chrome-bar gear nudge MUST declare `required: true` AND
  // omit `defaultValue` (so `getDefaultProps` leaves the key absent on
  // slash-insert and the parser preserves "key absent" through markdown
  // round-trip). A future descriptor — or a future schema flip on an
  // existing one — that adds `defaultValue: ''` would silently disable
  // the gear nudge for that prop (the predicate observes the stamped
  // empty string and concludes "satisfied"). That's the exact regression
  // this guard prevents from re-entering through any other required
  // string descriptor.
  test('no required string prop declares `defaultValue: ""` (defeats key-absence predicate)', () => {
    // Documented exception: `src` on media descriptors uses the upload-flow
    // pattern — slash-insert opens an upload modal (`uploadAndInsert` in
    // `image-upload/index.ts`) that fills `src` BEFORE the component lands
    // in the doc. The empty-string default is a transient parser state for
    // descriptors that haven't yet been bridged from their slash-insert
    // dialog; the gear-nudge pattern (`alt` per precedent #46) is a
    // distinct UX surface for that prop class. Both patterns coexist: the
    // exception itself is the precedent. New required-string descriptors
    // must EITHER drop `defaultValue` (gear-nudge UX) OR set a meaningful
    // non-empty default (default-fills-itself); `defaultValue: ""` on a
    // required string prop without an upload-flow ergonomic is the bug
    // class this guard catches.
    // Descriptor+prop tuples — exemption is targeted at known media
    // descriptors that use the slash-insert upload modal. Future `src`
    // props on non-upload descriptors (e.g., a hypothetical Script or
    // Link descriptor) are NOT auto-exempted; their absence from this
    // set will trigger the offender list and force explicit review.
    const EXEMPT_BY_UPLOAD_FLOW = new Set<string>([
      'img.src',
      'video.src',
      'audio.src',
      'Pdf.src',
      'File.src',
      'Embed.src',
      'CommonMarkImage.src',
    ]);

    const offenders: string[] = [];
    for (const d of builtInComponents) {
      for (const p of d.props) {
        if (p.type !== 'string') continue;
        if (p.required !== true) continue;
        if (!('defaultValue' in p)) continue;
        if (p.defaultValue !== '') continue;
        if (EXEMPT_BY_UPLOAD_FLOW.has(`${d.name}.${p.name}`)) continue;
        offenders.push(`${d.name}.${p.name}`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Schema-flip drift detected — these required string props declare \`defaultValue: ""\` ` +
          `which silently disables the chrome-bar gear nudge (precedent #46). Drop \`defaultValue\` ` +
          `to make the key-absence predicate fire on slash-insert (correct behavior for ` +
          `the WCAG-1.1.1 decorative opt-in pattern), or set a meaningful non-empty default ` +
          `if the prop has a real default value. Offenders: ${offenders.join(', ')}. ` +
          `If the descriptor uses an upload-flow ergonomic (slash-insert dialog fills the prop ` +
          `before the component lands), add the descriptor+prop tuple (e.g., 'Foo.src') to ` +
          `EXEMPT_BY_UPLOAD_FLOW with a comment naming the dialog source.`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  // Forward-looking sibling: required string props with NO defaultValue
  // are the canonical shape for the gear-nudge contract. This positive
  // pin asserts the set of required-no-default props is non-empty —
  // i.e., the registry has at least one descriptor exercising precedent
  // #45's tri-state pattern. Acts as a anti-vacuousness check for the
  // negative guard above (without this, a future refactor that removes
  // ALL required-no-default props would silently make the negative guard
  // vacuously pass).
  test('at least one descriptor exercises the required-no-defaultValue tri-state contract', () => {
    let count = 0;
    for (const d of builtInComponents) {
      for (const p of d.props) {
        if (p.type === 'string' && p.required === true && !('defaultValue' in p)) {
          count++;
        }
      }
    }
    // Current adopters (≥5): img.alt, CommonMarkImage.alt (identity-shared),
    // Accordion.title, Math.formula, MermaidFence.chart. The ≥ 2 floor is
    // conservative — it survives a future refactor that drops a few adopters
    // (e.g., drops the identity-share without dropping the contract entirely)
    // without falsely passing if ALL adopters are removed.
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

import { describe, expect, test } from 'vitest';
import { emitMdxJsx } from '../markdown/serialize-helpers.ts';
import { builtInComponents, createRegistry, wildcardMeta } from './index.ts';
import type { JsxComponentMeta } from './types.ts';

describe('createRegistry', () => {
  test('returns the 17 canonical + 9 compat descriptors + wildcard', () => {
    const registry = createRegistry();
    const entries = [...registry.entries()];
    expect(entries.length).toBe(27);
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

    expect(registry.get('DataViz')).toBeUndefined();
    expect(registry.getOrWildcard('DataViz').name).toBe('*');

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
    expect(registry.has('Toggle')).toBe(true);
    expect(registry.has('Math')).toBe(true);
    expect(registry.has('MermaidFence')).toBe(true);
    expect(registry.has('Mermaid')).toBe(false);
    expect(registry.has('Pdf')).toBe(true);
    expect(registry.has('File')).toBe(true);
    expect(registry.has('Tabs')).toBe(true);
    expect(registry.has('Tab')).toBe(true);
    expect(registry.has('Embed')).toBe(true);
    expect(registry.has('Mirror')).toBe(true);
    expect(registry.has('MirrorSource')).toBe(true);
    expect(registry.has('*')).toBe(true);
    expect(registry.has('Image')).toBe(false);
    expect(registry.has('Video')).toBe(false);
    expect(registry.has('Audio')).toBe(false);
    expect(registry.has('Steps')).toBe(false);
    expect(registry.has('DataViz')).toBe(false);
  });
});

describe('builtInComponents manifest', () => {
  test('contains 17 canonical + 9 compat entries (5-pack + Math + MermaidFence + Pdf + File + Excalidraw + Tabs + Tab + Embed + Mirror + MirrorSource + HtmlAlignBlock + Toggle canonicals; source-form preservation + math syntax + wiki-embed compats; Mermaid is fence-only)', () => {
    expect(builtInComponents.length).toBe(26);
    const canonical = builtInComponents.filter((m) => m.surface === 'canonical');
    const compat = builtInComponents.filter((m) => m.surface === 'compat');
    expect(canonical.length).toBe(17);
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
    for (const meta of builtInComponents) {
      expect(meta.description).toBeTruthy();
      if (meta.surface === 'canonical') {
        expect(Array.isArray(meta.searchTerms)).toBe(true);
        expect(meta.searchTerms?.length).toBeGreaterThan(0);
      }
    }
  });

  test('every enum PropDef defaultValue is in enumValues (Mi1 manifest-drift guard)', () => {
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
    const containers = builtInComponents.filter((m) => m.emptyChildName);
    const names = containers.map((c) => `${c.name}→${c.emptyChildName}`).sort();
    expect(
      names,
      `Unexpected compound descriptor set: ${names.join(', ')}. Either update this assertion (and extend A11Y07 coverage) or revert the emptyChildName addition.`,
    ).toEqual(['Tabs→Tab']);
  });

  test('Tabs descriptor prop surface is exactly `id` (the deep-link anchor)', () => {
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
    const callout = builtInComponents.find((m) => m.name === 'Callout');
    expect(callout).toBeDefined();
    if (!callout) return;
    const propNames = callout.props.map((p) => p.name).sort();
    expect(propNames).toEqual(
      ['children', 'collapsible', 'color', 'defaultOpen', 'icon', 'title', 'type'].sort(),
    );
  });

  test('img exposes the 13-prop HTML-native surface (3 common + 10 advanced)', () => {
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
    const img = builtInComponents.find((m) => m.name === 'img');
    const align = img?.props.find((p) => p.name === 'align');
    expect(align).toBeDefined();
    if (align?.type === 'enum') {
      expect([...align.enumValues].sort()).toEqual(['center', 'left', 'right'].sort());
      expect(align.defaultValue).toBe('center');
      expect(align.omitOnDefault).toBe(true);
      expect(align.advanced).toBeUndefined();
      expect(align.hidden).toBe(true);
      expect(align.enumValues[0]).toBe('center');
    }
  });

  test('img.alt is required with no defaultValue (WCAG 1.1.1 — must be a deliberate decision)', () => {
    const img = builtInComponents.find((m) => m.name === 'img');
    const alt = img?.props.find((p) => p.name === 'alt');
    expect(alt).toBeDefined();
    expect(alt?.required).toBe(true);
    expect(alt && 'defaultValue' in alt).toBe(false);
  });

  test('CommonMarkImage.alt inherits required:true via htmlImgProps[1] identity-share', () => {
    const img = builtInComponents.find((m) => m.name === 'img');
    const cmi = builtInComponents.find((m) => m.name === 'CommonMarkImage');
    const imgAlt = img?.props.find((p) => p.name === 'alt');
    const cmiAlt = cmi?.props.find((p) => p.name === 'alt');
    expect(imgAlt).toBeDefined();
    expect(cmiAlt).toBeDefined();
    expect(Object.is(imgAlt, cmiAlt)).toBe(true);
    expect(cmiAlt?.required).toBe(true);
    expect(cmiAlt && 'defaultValue' in cmiAlt).toBe(false);
  });

  test('CommonMarkImage compat exposes exactly src + alt + title (no align)', () => {
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
    const img = builtInComponents.find((m) => m.name === 'img');
    expect(img?.props.find((p) => p.name === 'zoom')).toBeUndefined();
    expect(img?.props.find((p) => p.name === 'caption')).toBeUndefined();
  });

  test('img stays `isSelfClosing: true` (no children slot)', () => {
    const img = builtInComponents.find((m) => m.name === 'img');
    expect(img?.hasChildren).toBe(false);
    expect(img?.isSelfClosing).toBe(true);
  });

  test('video exposes the 12-prop HTML-native surface (2 common + 10 advanced)', () => {
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
    const img = builtInComponents.find((m) => m.name === 'img');
    const video = builtInComponents.find((m) => m.name === 'video');
    const imgAlign = img?.props.find((p) => p.name === 'align');
    const videoAlign = video?.props.find((p) => p.name === 'align');
    expect(imgAlign).toBeDefined();
    expect(videoAlign).toBeDefined();
    expect(videoAlign).toEqual(imgAlign);
  });

  test('Embed.align mirrors img.align (single alignment surface — bubble menu)', () => {
    const img = builtInComponents.find((m) => m.name === 'img');
    const embed = builtInComponents.find((m) => m.name === 'Embed');
    const imgAlign = img?.props.find((p) => p.name === 'align');
    const embedAlign = embed?.props.find((p) => p.name === 'align');
    expect(imgAlign).toBeDefined();
    expect(embedAlign).toBeDefined();
    expect(embedAlign).toEqual(imgAlign);
  });

  test('video has `controls` as a boolean with `true` default', () => {
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
    const video = builtInComponents.find((m) => m.name === 'video');
    expect(video?.hasChildren).toBe(false);
    expect(video?.isSelfClosing).toBe(true);
  });

  test('video has no `start` prop (matches Mintlify / Fumadocs)', () => {
    const video = builtInComponents.find((m) => m.name === 'video');
    const start = video?.props.find((p) => p.name === 'start');
    expect(start).toBeUndefined();
  });

  test('audio exposes the 7-prop HTML-native surface (1 common + 6 advanced)', () => {
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
    const accordion = builtInComponents.find((m) => m.name === 'Accordion');
    expect(accordion).toBeDefined();
    if (!accordion) return;
    const propNames = accordion.props.map((p) => p.name).sort();
    expect(propNames).toEqual(['title', 'defaultOpen', 'icon', 'description', 'id', 'name'].sort());
  });

  test('Accordion has `title` as a required string', () => {
    const accordion = builtInComponents.find((m) => m.name === 'Accordion');
    const title = accordion?.props.find((p) => p.name === 'title');
    expect(title).toBeDefined();
    expect(title?.type).toBe('string');
    expect(title?.required).toBe(true);
  });

  test('Accordion has `defaultOpen` as a boolean with `false` default', () => {
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
    const accordion = builtInComponents.find((m) => m.name === 'Accordion');
    expect(accordion?.hasChildren).toBe(true);
    expect(accordion?.isSelfClosing).toBeUndefined();
  });

  test('Accordion has no `variant` prop (D-MF14 — NG30 preserves Notion color-map path)', () => {
    const accordion = builtInComponents.find((m) => m.name === 'Accordion');
    const variant = accordion?.props.find((p) => p.name === 'variant');
    expect(variant).toBeUndefined();
  });

  test('Accordion has no `emptyChildName` (D-MF16 — ships standalone, not compound)', () => {
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
    const mermaid = builtInComponents.find((m) => m.name === 'MermaidFence');
    expect(mermaid).toBeDefined();
    if (!mermaid) return;
    const propNames = mermaid.props.map((p) => p.name).sort();
    expect(propNames).toEqual(['chart']);
  });

  test('MermaidFence keeps `chart` in the descriptor schema but hides it from PropPanel', () => {
    const mermaid = builtInComponents.find((m) => m.name === 'MermaidFence');
    const chart = mermaid?.props.find((p) => p.name === 'chart');
    expect(chart).toBeDefined();
    expect(chart?.type).toBe('string');
    expect(chart?.required).toBe(true);
    expect(chart?.hidden).toBe(true);
  });

  test('MermaidFence has no editable props — chrome `gear` icon is suppressed', () => {
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
    const validCategories = new Set(['content', 'layout', 'media', 'data', 'embed']);
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
  type Split = { common: string[]; advanced: string[] };
  const expected: Record<string, Split> = {
    img: {
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
      common: ['chart'],
      advanced: [],
    },
    Pdf: {
      common: ['src'],
      advanced: ['title', 'anchor'],
    },
    File: {
      common: ['src'],
      advanced: [],
    },
    Embed: {
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
  test('no required string prop declares `defaultValue: ""` (defeats key-absence predicate)', () => {
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

  test('at least one descriptor exercises the required-no-defaultValue tri-state contract', () => {
    let count = 0;
    for (const d of builtInComponents) {
      for (const p of d.props) {
        if (p.type === 'string' && p.required === true && !('defaultValue' in p)) {
          count++;
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

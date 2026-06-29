import { describe, expect, test } from 'bun:test';
import { builtInComponents, createRegistry } from './index.ts';
import type { CompatMeta, JsxComponentMeta } from './types.ts';

const canonicalDescriptors = builtInComponents.filter(
  (m): m is JsxComponentMeta & { surface: 'canonical' } => m.surface === 'canonical',
);
const compatDescriptors = builtInComponents.filter((m): m is CompatMeta => m.surface === 'compat');

describe('canonical/compat split — registry shape', () => {
  test('every descriptor has a `surface` discriminator', () => {
    for (const meta of builtInComponents) {
      expect(meta.surface === 'canonical' || meta.surface === 'compat').toBe(true);
    }
  });

  test('exactly 14 canonical descriptors (5-pack + Math + MermaidFence + Pdf + File + Tabs + Tab + Embed + Mirror + MirrorSource)', () => {
    expect(canonicalDescriptors.length).toBe(14);
    expect(canonicalDescriptors.map((m) => m.name).sort()).toEqual(
      [
        'Accordion',
        'Callout',
        'Embed',
        'File',
        'Math',
        'MermaidFence',
        'Mirror',
        'MirrorSource',
        'Pdf',
        'Tab',
        'Tabs',
        'audio',
        'img',
        'video',
      ].sort(),
    );
  });

  test('compat descriptor set covers v1 source-form preservation + WikiEmbed convergence + math syntax', () => {
    expect(compatDescriptors.map((m) => m.name).sort()).toEqual(
      [
        'CommonMarkImage',
        'DollarMath',
        'GFMCallout',
        'HtmlDetailsAccordion',
        'MathFence',
        'WikiEmbedAudio',
        'WikiEmbedFile',
        'WikiEmbedImage',
        'WikiEmbedVideo',
      ].sort(),
    );
  });

  test('every descriptor declares a `serialize` function', () => {
    for (const meta of builtInComponents) {
      expect(typeof meta.serialize).toBe('function');
    }
  });
});

describe('compat descriptors — contract invariants', () => {
  test('every compat `rendersAs` resolves to a registered canonical (T7)', () => {
    const registry = createRegistry();
    for (const meta of compatDescriptors) {
      const target = registry.get(meta.rendersAs);
      expect(target).toBeDefined();
      expect(target?.surface).toBe('canonical');
    }
  });

  test('v1 compats (Callout/CommonMarkImage/Details) declare identity `translateProps` (T2)', () => {
    const v1Names = new Set(['GFMCallout', 'CommonMarkImage', 'HtmlDetailsAccordion']);
    const probe = { type: 'note', title: 'X', src: 'foo.png', alt: 'A', collapsible: true };
    for (const meta of compatDescriptors) {
      if (!v1Names.has(meta.name)) continue;
      expect(meta.translateProps(probe)).toEqual(probe);
    }
  });
});

describe('compat descriptors — prop-set is a subset of canonical', () => {
  test('GFMCallout props are a subset of Callout props', () => {
    const callout = canonicalDescriptors.find((m) => m.name === 'Callout');
    const gfm = compatDescriptors.find((m) => m.name === 'GFMCallout');
    if (!callout || !gfm) throw new Error('Missing descriptor');
    const canonicalNames = new Set(callout.props.map((p) => p.name));
    for (const p of gfm.props) {
      expect(canonicalNames.has(p.name)).toBe(true);
    }
  });

  test('CommonMarkImage props are a subset of img props', () => {
    const img = canonicalDescriptors.find((m) => m.name === 'img');
    const cm = compatDescriptors.find((m) => m.name === 'CommonMarkImage');
    if (!img || !cm) throw new Error('Missing descriptor');
    const canonicalNames = new Set(img.props.map((p) => p.name));
    for (const p of cm.props) {
      expect(canonicalNames.has(p.name)).toBe(true);
    }
  });

  test('HtmlDetailsAccordion props are a subset of Accordion props', () => {
    const accordion = canonicalDescriptors.find((m) => m.name === 'Accordion');
    const html = compatDescriptors.find((m) => m.name === 'HtmlDetailsAccordion');
    if (!accordion || !html) throw new Error('Missing descriptor');
    const canonicalNames = new Set(accordion.props.map((p) => p.name));
    for (const p of html.props) {
      expect(canonicalNames.has(p.name)).toBe(true);
    }
  });

  test('DollarMath props are a subset of Math props', () => {
    const math = canonicalDescriptors.find((m) => m.name === 'Math');
    const dm = compatDescriptors.find((m) => m.name === 'DollarMath');
    if (!math || !dm) throw new Error('Missing descriptor');
    const canonicalNames = new Set(math.props.map((p) => p.name));
    for (const p of dm.props) {
      expect(canonicalNames.has(p.name)).toBe(true);
    }
  });

  test('MathFence props are a subset of Math props', () => {
    const math = canonicalDescriptors.find((m) => m.name === 'Math');
    const mf = compatDescriptors.find((m) => m.name === 'MathFence');
    if (!math || !mf) throw new Error('Missing descriptor');
    const canonicalNames = new Set(math.props.map((p) => p.name));
    for (const p of mf.props) {
      expect(canonicalNames.has(p.name)).toBe(true);
    }
  });
});

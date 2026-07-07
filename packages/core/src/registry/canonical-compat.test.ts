/**
 * Canonical / compat split — architecture-locking unit tests.
 *
 * Covers:
 *  - identity `translateProps` on all v1 compat descriptors.
 *  - slash menu (via `getRegisteredDescriptors` filter contract).
 *  - registry build is consistent — every compat's `rendersAs` resolves
 *        to a registered canonical descriptor.
 *
 * Round-trip tests for the source-form preservation property live in
 * `invariant-i13.test.ts` (PBT) and `invariant-
 * i19.test.ts` (HTML5 details ↔ Accordion structural equivalence).
 */

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
    // Media canonicals with a matching HTML primitive are lowercase
    // (img/video/audio). Non-native canonicals stay capitalized
    // (Callout, Accordion, Math, MermaidFence, Pdf, File, Tabs, Tab,
    // Embed, Mirror, MirrorSource). The Mermaid canonical is named
    // `MermaidFence` because the only authoring form is the ` ```mermaid `
    // fence — `Mermaid` is intentionally NOT a registered name so legacy
    // `<Mermaid />` JSX content falls through to the wildcard. `Mirror` +
    // `MirrorSource` are the master/copy block-transclusion pair.
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
    // v1 set: GFMCallout / CommonMarkImage / HtmlDetailsAccordion (alternative
    // surface forms that already shared canonical's prop spelling — identity
    // translateProps). WikiEmbedImage / WikiEmbedVideo / WikiEmbedAudio
    // carry a non-identity translateProps (alias → alt for img;
    // alias → title for video/audio since neither HTML5 element accepts an
    // `alt` attribute) — they prove the seam scales beyond identity remaps
    // and converge media authoring shapes on the same React component
    // dispatch surface. WikiEmbedFile extended the seam to
    // any non-media attachment extension (.pdf / .docx / .zip / …) — all
    // dropped attachments render through `File.tsx`'s inline-row chrome.
    // DollarMath / MathFence extend the same seam to math
    // syntax forms. WikiEmbedPdf was removed — the wikilink
    // form for PDFs now goes through WikiEmbedFile alongside other
    // attachments; the pdfjs canvas viewer stays available via the
    // `<Pdf src="..." />` JSX form.
    //
    // Mermaid has NO compat row: the ` ```mermaid ` fence is the canonical
    // authoring form, and the canonical descriptor itself is named
    // `MermaidFence`. There is no `Mermaid` descriptor — that name
    // intentionally falls through to the wildcard so legacy `<Mermaid />`
    // JSX content renders as the raw-mdx editable source block.
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
    // v1's compat fixtures share canonical's prop-name spelling — identity
    // remap. WikiEmbedImage and its video/audio siblings carry a non-identity
    // remap (alias → alt) and are tested separately by their own descriptor
    // tests; this test pins the v1 set so a regression to one of them shows
    // up here rather than as a render-shape oddity.
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

  // Mermaid: fence-only — there is no compat row, so no subset assertion.
  // The canonical descriptor is `MermaidFence`; its serialize emits the
  // ` ```mermaid ` fence directly.
});

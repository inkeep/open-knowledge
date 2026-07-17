#!/usr/bin/env -S npx tsx
/**
 * Generate one MDX page per canonical OpenKnowledge JSX component under
 * `content/reference/components/`. Reads `builtInComponents` from
 * `@inkeep/open-knowledge-core` so the docs stay in lockstep with the
 * runtime manifest.
 *
 * Compat descriptors (GfmCallout, CommonMarkImage, WikiEmbed*) are skipped
 * — they're read-only round-trip helpers, never author-facing.
 *
 * Wildcard `*` is skipped — it's the fallback renderer, not a component.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PropDef } from '@inkeep/open-knowledge-core';
import { builtInComponents } from '@inkeep/open-knowledge-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '../content/reference/components');

// Ordered list drives the sidebar. Canonical shipping order matches the
// slash-menu grouping: content first, then media, then transclusion.
// Composition children (Tab, MirrorSource) don't get their own pages —
// they're rolled into the parent's doc via COMPOSITION_CHILDREN below,
// since they only make sense in that context.
const PAGE_ORDER = [
  'Callout',
  'Accordion',
  'Tabs',
  'Math',
  'MermaidFence',
  'img',
  'video',
  'audio',
  'Pdf',
  'File',
  'Embed',
  'Mirror',
] as const;

/**
 * Parent → child pairs where the child ONLY makes sense inside the
 * parent's tag (`<Tab>` inside `<Tabs>`, `<MirrorSource>` at the far end
 * of a `<Mirror src=… anchor=…>`). Rendered as an appended "Also:" block
 * on the parent's page instead of a standalone sidebar entry. Keys are
 * canonical descriptor names.
 */
const COMPOSITION_CHILDREN: Partial<Record<string, string>> = {
  Tabs: 'Tab',
  Mirror: 'MirrorSource',
};

const COMPOSITION_CHILD_NAMES = new Set(Object.values(COMPOSITION_CHILDREN));

/**
 * Every component has a most-idiomatic authoring form the reader should see
 * first. For most that's a plain markdown / GFM / wikilink / fence
 * shape; a few (Tabs / Pdf / Embed / Mirror / MirrorSource) only exist as
 * JSX and fall through to the auto-emitted `<Tag …>` example.
 *
 * Each entry is `{ language, code }` where `language` is the ` ``` `-
 * fence label (feeds shiki syntax-highlighting) and `code` is the
 * verbatim source. If the primary language is one Fumadocs transforms
 * on-page (mermaid, mdx), the emitter wraps it in a 4-backtick outer
 * fence so it renders as literal source instead of a live block.
 */
const CANONICAL_SYNTAX: Partial<Record<string, { language: string; code: string }>> = {
  Callout: {
    language: 'md',
    code: `> [!TIP]
> Pick the type that matches the intent — \`tip\` for advice, \`warning\`
> for things that can bite, \`note\` for background context.`,
  },
  // Accordion also has an HTML5 `<details>`/`<summary>` compat form, but
  // it can't carry the `icon` / `description` / `title` props the panel
  // documents. Skip the canonical override so the sample uses the JSX
  // form and stays in sync with the prop reference.
  Math: {
    language: 'md',
    code: `$$
E = mc^2
$$`,
  },
  MermaidFence: {
    language: 'mermaid',
    code: `graph LR
    Author((Author)) --> Editor[OK Editor]
    Editor -- CRDT --> Server[(Hocuspocus)]
    Server --> Agent{{AI Agent}}
    Agent --> Editor`,
  },
  img: {
    language: 'md',
    code: `![A short description](./path/to/image.png)`,
  },
  video: {
    language: 'md',
    code: `![[demo-clip.mp4]]`,
  },
  audio: {
    language: 'md',
    code: `![[podcast-episode.mp3]]`,
  },
  File: {
    language: 'md',
    code: `![[quarterly-report.pdf]]`,
  },
  // The auto-generated Mirror example plugs `placeholderFor('src')` into
  // `src`, which yields an image URL — that contradicts the props table
  // where `src` is a doc path. Override so the sample reads like the
  // live preview above it.
  Mirror: {
    language: 'mdx',
    code: `<Mirror src="specs/architecture" anchor="overview-diagram" />`,
  },
};

/** Languages Fumadocs remark plugins convert into a live component when
 * they appear as a top-level fence (mermaid → `<Mermaid>`, mdx →
 * component). Wrap those in a 4-backtick outer fence so the sample
 * renders as literal source rather than a duplicate live block. */
const AUTO_TRANSFORMED_LANGUAGES = new Set(['mermaid', 'mdx']);

/** kebab-case slug for the file name (also the URL segment). */
function slugOf(name: string): string {
  // MermaidFence → mermaid-fence; MirrorSource → mirror-source; img stays img.
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function typeLabel(prop: PropDef): string {
  switch (prop.type) {
    case 'enum':
      return prop.enumValues.map((v) => `'${v}'`).join(' | ');
    case 'reactnode':
      return 'ReactNode';
    default:
      return prop.type;
  }
}

function escapeMdx(value: string): string {
  return value.replace(/`/g, '\\`').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

/**
 * Emit a fenced code block for a sample. Auto-transformed languages get
 * wrapped in a 4-backtick outer fence so the sample renders as literal
 * source instead of triggering the corresponding remark plugin (which
 * would replace the whole block with a live-rendered component alongside
 * the preview above).
 */
function renderCodeSample({ language, code }: { language: string; code: string }): string {
  if (AUTO_TRANSFORMED_LANGUAGES.has(language)) {
    return `\`\`\`\`text\n\`\`\`${language}\n${code}\n\`\`\`\n\`\`\`\``;
  }
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

/** Trim a single trailing period so the frontmatter subtitle reads cleanly.
 * Fumadocs renders the description in a distinct type block; keeping the
 * terminal punctuation off matches how the other reference pages read. */
function trimTrailingPeriod(value: string): string {
  return value.replace(/\.\s*$/, '');
}

function renderTypeTable(props: PropDef[]): string {
  const visible = props.filter((p) => !p.hidden);
  if (visible.length === 0) return '_No public props._';
  const entries = visible
    .map((p) => {
      const description = p.description ? escapeMdx(p.description) : '';
      const type = typeLabel(p);
      const defaultLine =
        'defaultValue' in p && p.defaultValue !== undefined
          ? `\n    default: ${JSON.stringify(String(p.defaultValue))},`
          : '';
      return `  ${JSON.stringify(p.name)}: {\n    description: ${JSON.stringify(description)},\n    type: ${JSON.stringify(type)},\n    required: ${p.required},${defaultLine}\n  }`;
    })
    .join(',\n');
  return `<TypeTable\n  type={{\n${entries},\n}}\n/>`;
}

/**
 * Build a minimal JSX example. For self-closing tags, emit `<Name prop="..." />`
 * with a couple of representative attrs. For containers, emit an open/close
 * pair with placeholder body.
 */
function renderExample(meta: (typeof builtInComponents)[number]): string {
  const name = meta.name;
  // Pick 1-3 non-hidden props to demo — prefer required + enum defaults + a title/src.
  const publicProps = meta.props.filter((p) => !p.hidden);
  const featured = [
    ...publicProps.filter((p) => p.required).slice(0, 3),
    ...publicProps
      .filter((p) => !p.required && (p.name === 'title' || p.name === 'src' || p.name === 'type'))
      .slice(0, 2),
  ];
  const seen = new Set<string>();
  const chosen = featured.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });

  const attrs = chosen
    .map((p) => {
      if (p.type === 'boolean') return p.name;
      if (p.type === 'enum') return `${p.name}="${p.enumValues[0]}"`;
      if (p.type === 'number') {
        // Guard against a non-numeric `defaultValue` sneaking in from a
        // future descriptor — Number.isFinite rejects strings, NaN, and
        // undefined, so we fall back to `1` instead of emitting invalid
        // JSX like `width={"foo"}`.
        const raw = p.defaultValue;
        const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
        return `${p.name}={${value}}`;
      }
      if (p.type === 'reactnode') return null;
      const defaultStr =
        'defaultValue' in p && p.defaultValue !== undefined
          ? String(p.defaultValue)
          : placeholderFor(p.name);
      return `${p.name}="${defaultStr}"`;
    })
    .filter(Boolean)
    .join(' ');

  const attrPart = attrs ? ` ${attrs}` : '';
  if (meta.hasChildren) {
    const body = meta.exampleBody?.trim() ?? placeholderBody(name);
    return `<${name}${attrPart}>\n  ${body}\n</${name}>`;
  }
  return `<${name}${attrPart} />`;
}

function placeholderFor(propName: string): string {
  const map: Record<string, string> = {
    src: 'https://example.com/asset.png',
    href: 'https://example.com',
    alt: 'A short description',
    title: 'Title',
    formula: 'E = mc^2',
    chart: 'graph LR; A --> B',
    id: 'demo-1',
    name: 'group-a',
  };
  return map[propName] ?? '…';
}

/**
 * Live preview blocks, keyed by component name. Rendered above the code
 * example so readers see what the block actually looks like. Every entry
 * uses the paired `<XPreview>` React component wired in `mdx-components.tsx`;
 * `Mermaid` reuses the docs-side renderer already registered there.
 */
const PREVIEWS: Partial<Record<string, string>> = {
  Callout: `<ComponentPreview>
  <CalloutPreview type="tip" title="Ship a good default">
    Pick the type that matches the intent — <code>tip</code> for advice,
    <code>warning</code> for things that can bite, <code>note</code> for
    background context. The icon and accent color track the type automatically.
  </CalloutPreview>
</ComponentPreview>`,
  Accordion: `<ComponentPreview>
  <AccordionPreview title="Show me the details" description="Click to expand" icon="lucide:BookOpen">
    Native \`<details>\` under the hood — same substrate as the app render.
    Pass a shared \`name\` to sibling accordions and the browser will keep
    only one open at a time.
  </AccordionPreview>
</ComponentPreview>`,
  Tabs: `<ComponentPreview>
  <TabsPreview>
    <TabPreview label="Install">
      Run \`npm install @inkeep/open-knowledge\` to add the CLI to your project.
    </TabPreview>
    <TabPreview label="Configure">
      Point \`.ok/config.yml\` at your content directory. Frontmatter, ignore
      patterns, and folder defaults all live in this one file.
    </TabPreview>
    <TabPreview label="Serve">
      \`ok start\` boots the collaboration server and opens the editor.
    </TabPreview>
  </TabsPreview>
</ComponentPreview>`,
  Tab: `<ComponentPreview>
  <TabsPreview>
    <TabPreview label="A single Tab">
      Each <code>&lt;Tab&gt;</code> is one panel of a <code>&lt;Tabs&gt;</code>
      group. The <code>label</code> becomes the pill at the top; the body
      renders when the pill is active.
    </TabPreview>
    <TabPreview label="Second panel">
      Switch between panels without losing scroll — the parent tracks which
      one is active client-side.
    </TabPreview>
  </TabsPreview>
</ComponentPreview>`,
  Math: `<ComponentPreview>
  <MathPreview formula="E = mc^2" />
</ComponentPreview>`,
  MermaidFence: `<ComponentPreview>
  <Mermaid chart={\`graph LR
    Author((Author)) --> Editor[OK Editor]
    Editor -- CRDT --> Server[(Hocuspocus)]
    Server --> Agent{{AI Agent}}
    Agent --> Editor\`} />
</ComponentPreview>`,
  img: `<ComponentPreview>
  <ImgPreview
    src="https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=800&q=80"
    alt="Forest at sunrise"
    caption="A photo from Unsplash — click to zoom in the app."
  />
</ComponentPreview>`,
  video: `<ComponentPreview>
  <VideoPreview
    src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"
    controls
  />
</ComponentPreview>`,
  audio: `<ComponentPreview>
  <AudioPreview
    src="https://actions.google.com/sounds/v1/alarms/beep_short.ogg"
    controls
  />
</ComponentPreview>`,
  Pdf: `<ComponentPreview>
  <PdfPreview src="https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf" />
</ComponentPreview>`,
  File: `<ComponentPreview>
  <FilePreview name="quarterly-report.pdf" size="124 KB" />
</ComponentPreview>`,
  Embed: `<ComponentPreview>
  <EmbedPreview
    src="https://openknowledge.ai/"
    title="OpenKnowledge marketing site"
  />
</ComponentPreview>`,
  Mirror: `<ComponentPreview>
  <MirrorPreview src="specs/architecture" anchor="overview-diagram">
    This body renders live from wherever the \`<MirrorSource id="overview-diagram">\`
    with a matching id lives — edits there ripple here without a copy step.
  </MirrorPreview>
</ComponentPreview>`,
  MirrorSource: `<ComponentPreview>
  <MirrorSourcePreview id="overview-diagram">
    The canonical content this block owns. Every \`<Mirror>\` that references
    this id anywhere in the project reads from here.
  </MirrorSourcePreview>
</ComponentPreview>`,
};

function placeholderBody(name: string): string {
  if (name === 'Tabs')
    return '<Tab label="First">First panel</Tab>\n  <Tab label="Second">Second panel</Tab>';
  if (name === 'Tab') return 'Panel body content.';
  if (name === 'Accordion') return 'Body content — hidden until the summary is clicked.';
  if (name === 'Callout') return 'Content of the callout goes here.';
  if (name === 'MirrorSource') return 'The canonical content this block owns.';
  return 'Content goes here.';
}

function renderPage(
  meta: (typeof builtInComponents)[number],
  byName: Map<string, (typeof builtInComponents)[number]>,
): string {
  const title = meta.displayName ?? meta.name;
  const rawDescription = meta.description ?? `${title} component`;
  const frontmatterDescription = trimTrailingPeriod(rawDescription);
  const keywords = meta.searchTerms?.slice(0, 12).join(', ') ?? '';
  const example = renderExample(meta);
  const propsTable = renderTypeTable(meta.props);
  const searchTermsLine = meta.searchTerms?.length
    ? // No trailing period after the last inline-code chip — the space before
      // `.` renders as a distracting dangling dot next to the last chip.
      `_Also matches:_ ${meta.searchTerms.map((t) => `\`${t}\``).join(', ')}\n\n`
    : '';

  const preview = PREVIEWS[meta.name];
  const previewBlock = preview ? `${preview}\n\n` : '';

  const childName = COMPOSITION_CHILDREN[meta.name];
  const childMeta = childName ? byName.get(childName) : undefined;
  const childBlock = childMeta ? renderChildSection(childMeta) : '';

  const canonical = CANONICAL_SYNTAX[meta.name];
  const codeSample = canonical ? renderCodeSample(canonical) : `\`\`\`mdx\n${example}\n\`\`\``;

  return `---
title: ${JSON.stringify(title)}
description: ${JSON.stringify(frontmatterDescription)}${keywords ? `\nkeywords: ${JSON.stringify(keywords)}` : ''}
---

## Example

${previewBlock}${codeSample}

## Props

${propsTable}

${childBlock}${searchTermsLine}## Author it

Type \`/${(meta.searchTerms?.[0] ?? meta.name).toLowerCase()}\` in the editor to insert it from the slash menu, or write the tag directly in source mode. The Properties panel on the right of the editor exposes every prop above as a form field once the block is selected.
`;
}

/**
 * Render the composition-child section appended to the parent's page —
 * `Tab` under `Tabs`, `MirrorSource` under `Mirror`. Same shape as a
 * standalone page: description + optional preview + code example +
 * TypeTable, but without frontmatter or an "Author it" trailer since
 * the parent's covers it.
 */
function renderChildSection(child: (typeof builtInComponents)[number]): string {
  const title = child.displayName ?? child.name;
  const rawDescription = child.description ?? `${title} component`;
  const description = `${trimTrailingPeriod(rawDescription)}.`;
  const example = renderExample(child);
  const propsTable = renderTypeTable(child.props);
  const preview = PREVIEWS[child.name];
  const previewBlock = preview ? `${preview}\n\n` : '';
  return `## Also: \`<${child.name}>\`

${description}

${previewBlock}\`\`\`mdx
${example}
\`\`\`

${propsTable}

`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const canonical = builtInComponents.filter((c) => c.surface === 'canonical' && c.name !== '*');
  const byName = new Map(canonical.map((c) => [c.name, c] as const));

  const pagesInOrder: string[] = [];
  for (const name of PAGE_ORDER) {
    const meta = byName.get(name);
    if (!meta) {
      console.warn(
        `[generate-component-docs] canonical name "${name}" not found in registry — skipping`,
      );
      continue;
    }
    const slug = slugOf(name);
    const filePath = path.join(OUT_DIR, `${slug}.mdx`);
    await writeFile(filePath, renderPage(meta, byName));
    pagesInOrder.push(slug);
    console.log(`wrote ${path.relative(process.cwd(), filePath)}`);
  }

  // Any canonical component not in PAGE_ORDER — append at the end so a new
  // registry addition can't silently drop off the sidebar. Composition
  // children (Tab, MirrorSource) are folded into their parents' pages
  // above, so intentionally skipped here.
  for (const meta of canonical) {
    if ((PAGE_ORDER as readonly string[]).includes(meta.name)) continue;
    if (COMPOSITION_CHILD_NAMES.has(meta.name)) continue;
    const slug = slugOf(meta.name);
    const filePath = path.join(OUT_DIR, `${slug}.mdx`);
    await writeFile(filePath, renderPage(meta, byName));
    pagesInOrder.push(slug);
    console.warn(
      `[generate-component-docs] canonical "${meta.name}" is not in PAGE_ORDER — appended at end`,
    );
  }

  const meta = {
    title: 'Components',
    icon: 'LuBlocks',
    pages: ['index', ...pagesInOrder],
  };
  await writeFile(path.join(OUT_DIR, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), path.join(OUT_DIR, 'meta.json'))}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

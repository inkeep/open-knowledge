#!/usr/bin/env -S npx tsx

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PropDef } from '@inkeep/open-knowledge-core';
import { builtInComponents } from '@inkeep/open-knowledge-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '../content/reference/components');

const PAGE_ORDER = [
  'Callout',
  'Accordion',
  'Toggle',
  'HtmlAlignBlock',
  'Tabs',
  'Math',
  'MermaidFence',
  'img',
  'video',
  'audio',
  'Pdf',
  'File',
  'Embed',
  'Excalidraw',
  'Mirror',
] as const;

const COMPOSITION_CHILDREN: Partial<Record<string, string>> = {
  Tabs: 'Tab',
  Mirror: 'MirrorSource',
};

const COMPOSITION_CHILD_NAMES = new Set(Object.values(COMPOSITION_CHILDREN));

const CANONICAL_SYNTAX: Partial<Record<string, { language: string; code: string }>> = {
  Callout: {
    language: 'md',
    code: `> [!TIP]
> Pick the type that matches the intent — \`tip\` for advice, \`warning\`
> for things that can bite, \`note\` for background context.`,
  },
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
  Mirror: {
    language: 'mdx',
    code: `<Mirror src="specs/architecture" anchor="overview-diagram" />`,
  },
};

const AUTO_TRANSFORMED_LANGUAGES = new Set(['mermaid', 'mdx']);

function slugOf(name: string): string {
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

function renderCodeSample({ language, code }: { language: string; code: string }): string {
  if (AUTO_TRANSFORMED_LANGUAGES.has(language)) {
    return `\`\`\`\`text\n\`\`\`${language}\n${code}\n\`\`\`\n\`\`\`\``;
  }
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

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

function renderExample(meta: (typeof builtInComponents)[number]): string {
  const name = meta.name;
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
        const raw = p.defaultValue;
        const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
        return `${p.name}={${value}}`;
      }
      if (p.type === 'reactnode') return null;
      const defaultStr =
        'defaultValue' in p && p.defaultValue !== undefined
          ? String(p.defaultValue)
          : placeholderFor(p.name, meta.name);
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

const PLACEHOLDER_OVERRIDES: Partial<Record<string, string>> = {
  'Excalidraw.src': 'diagrams/board.excalidraw',
};

const GENERIC_PLACEHOLDERS: Record<string, string> = {
  src: 'https://example.com/asset.png',
  href: 'https://example.com',
  alt: 'A short description',
  title: 'Title',
  formula: 'E = mc^2',
  chart: 'graph LR; A --> B',
  id: 'demo-1',
  name: 'group-a',
};

function placeholderFor(propName: string, componentName: string): string {
  return (
    PLACEHOLDER_OVERRIDES[`${componentName}.${propName}`] ?? GENERIC_PLACEHOLDERS[propName] ?? '…'
  );
}

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
  Toggle: `<ComponentPreview>
  <AccordionPreview title="Show me the details" description="Click to expand" icon="lucide:BookOpen">
    Native \`<details>\` under the hood — same substrate as the app render.
    Pass a shared \`name\` to sibling toggles and the browser will keep
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
    ? `_Also matches:_ ${meta.searchTerms.map((t) => `\`${t}\``).join(', ')}\n\n`
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

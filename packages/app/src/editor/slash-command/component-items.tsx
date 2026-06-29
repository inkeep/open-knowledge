
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { CopyPlus, ExternalLink, FileUp, Hash, Link2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { setPendingLinkEdit } from '../extensions/link-edit-autoopen';
import { markIdentityKey } from '../extensions/mark-identity';
import { uploadAndInsert } from '../image-upload/index.ts';
import { getInteractionLayer } from '../interaction-layer-host';
import { resolveIcon } from '../registry/icons.ts';
import { getDescriptor, getRegisteredDescriptors } from '../registry/index.ts';
import type { JsxComponentDescriptor } from '../registry/types.ts';
import type { SlashCommandItem } from './items';
import imagePreview from './preview-assets/image-preview.png';
import videoPreview from './preview-assets/video-preview.png';

interface PreviewConfig {
  description: MessageDescriptor;
  props?: Record<string, unknown>;
  children?: ReactNode;
  render?: () => ReactNode;
}

const PREVIEW_CONFIG: Record<string, PreviewConfig> = {
  Callout: {
    description: msg`Highlight tips, warnings, and notes.`,
    props: { type: 'note', title: 'Heads up' },
    children: 'Callouts draw attention to key information.',
  },
  Accordion: {
    description: msg`Collapsible section with a clickable summary.`,
    props: { title: 'Click to expand', defaultOpen: true },
    children: 'Hidden content goes here.',
  },
  img: {
    description: msg`Embed an image with optional alt text.`,
    props: { src: imagePreview, alt: 'Sample image' },
  },
  video: {
    description: msg`Embed a video with native player controls.`,
    props: { controls: true, poster: videoPreview },
  },
  audio: {
    description: msg`Embed an audio file with native player controls.`,
    props: { controls: true },
  },
  Math: {
    description: msg`Block math equation rendered with KaTeX from a LaTeX source string.`,
    props: { formula: 'c = \\pm\\sqrt{a^2 + b^2}' },
  },
  Embed: {
    description: msg`Embed an external page in an inline iframe (docs, demos, Figma, CodeSandbox).`,
    render: () => (
      <div className="flex h-full w-full flex-col overflow-hidden rounded-md border border-border bg-background">
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1.5">
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          <span className="ml-1.5 flex-1 truncate rounded-sm bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            https://example.com/embed
          </span>
        </div>
        <div className="flex flex-1 flex-col justify-center gap-1.5 px-3 py-2">
          <span className="h-1.5 w-3/4 rounded-sm bg-muted-foreground/30" />
          <span className="h-1.5 w-full rounded-sm bg-muted-foreground/20" />
          <span className="h-1.5 w-5/6 rounded-sm bg-muted-foreground/20" />
          <span className="h-1.5 w-2/3 rounded-sm bg-muted-foreground/20" />
        </div>
      </div>
    ),
  },
  Pdf: {
    description: msg`Multi-page PDF viewer with toolbar controls (thumbnails, page nav, zoom).`,
    render: () => (
      <div className="flex h-full w-full flex-col overflow-hidden rounded-md border border-border bg-background">
        <div className="flex items-center gap-1 border-b border-border bg-muted/40 px-1.5 py-1">
          {/* Thumbnails toggle (2x2 dots) */}
          <svg viewBox="0 0 12 12" className="size-3 text-muted-foreground" aria-hidden="true">
            <title>Thumbnails</title>
            <rect x="1" y="1" width="4" height="4" fill="currentColor" rx="0.5" />
            <rect x="7" y="1" width="4" height="4" fill="currentColor" rx="0.5" />
            <rect x="1" y="7" width="4" height="4" fill="currentColor" rx="0.5" />
            <rect x="7" y="7" width="4" height="4" fill="currentColor" rx="0.5" />
          </svg>
          <span className="ml-1 flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="rounded-sm bg-background px-1 py-0.5 font-mono">2</span>
            <span>/ 12</span>
          </span>
          <span className="ml-auto flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
            <span className="rounded-sm bg-background px-1 py-0.5">−</span>
            <span>100%</span>
            <span className="rounded-sm bg-background px-1 py-0.5">+</span>
          </span>
        </div>
        <div className="flex flex-1 gap-1 p-1.5">
          {/* Thumbnail strip */}
          <div className="flex w-6 flex-col gap-0.5">
            <span className="h-3 rounded-sm bg-muted-foreground/20" />
            <span className="h-3 rounded-sm border border-foreground/60 bg-background" />
            <span className="h-3 rounded-sm bg-muted-foreground/20" />
          </div>
          {/* Active page */}
          <div className="flex flex-1 flex-col gap-1 rounded-sm bg-background p-1.5">
            <span className="h-1.5 w-1/2 rounded-sm bg-foreground/50" />
            <span className="h-1 w-full rounded-sm bg-muted-foreground/30" />
            <span className="h-1 w-5/6 rounded-sm bg-muted-foreground/30" />
            <span className="h-1 w-full rounded-sm bg-muted-foreground/30" />
            <span className="h-1 w-2/3 rounded-sm bg-muted-foreground/30" />
          </div>
        </div>
      </div>
    ),
  },
  MermaidFence: {
    description: msg`Diagram from Mermaid source — flowchart, sequence, class, state, ER, gantt, pie.`,
    render: () => (
      <svg
        viewBox="0 0 200 120"
        className="h-full w-full text-foreground"
        aria-hidden="true"
        preserveAspectRatio="xMidYMid meet"
      >
        <title>Mermaid flowchart preview</title>
        <defs>
          <marker
            id="mermaid-preview-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {/* Start (rounded) */}
        <rect
          x="14"
          y="20"
          width="56"
          height="28"
          rx="14"
          fill="currentColor"
          fillOpacity="0.1"
          stroke="currentColor"
          strokeOpacity="0.7"
        />
        <text x="42" y="38" textAnchor="middle" fontSize="10" fill="currentColor">
          Start
        </text>
        {/* Decision (diamond) */}
        <polygon
          points="100,18 140,50 100,82 60,50"
          fill="currentColor"
          fillOpacity="0.1"
          stroke="currentColor"
          strokeOpacity="0.7"
        />
        <text x="100" y="54" textAnchor="middle" fontSize="10" fill="currentColor">
          Ready?
        </text>
        {/* End (rounded) */}
        <rect
          x="130"
          y="84"
          width="56"
          height="28"
          rx="14"
          fill="currentColor"
          fillOpacity="0.1"
          stroke="currentColor"
          strokeOpacity="0.7"
        />
        <text x="158" y="102" textAnchor="middle" fontSize="10" fill="currentColor">
          End
        </text>
        {/* Edges */}
        <line
          x1="70"
          y1="34"
          x2="80"
          y2="40"
          stroke="currentColor"
          strokeOpacity="0.7"
          strokeWidth="1.2"
          markerEnd="url(#mermaid-preview-arrow)"
        />
        <line
          x1="124"
          y1="62"
          x2="138"
          y2="82"
          stroke="currentColor"
          strokeOpacity="0.7"
          strokeWidth="1.2"
          markerEnd="url(#mermaid-preview-arrow)"
        />
        <text x="138" y="74" fontSize="8" fill="currentColor" opacity="0.6">
          yes
        </text>
      </svg>
    ),
  },
  Tabs: {
    description: msg`Horizontal pill strip + active panel below; click a pill to switch panels.`,
    render: () => (
      <div className="space-y-1.5">
        <div className="flex gap-1 border-b border-border pb-1">
          <span className="rounded-md bg-foreground/10 px-2 py-0.5 text-xs font-medium text-foreground">
            Tab 1
          </span>
          <span className="rounded-md px-2 py-0.5 text-xs text-muted-foreground">Tab 2</span>
        </div>
        <p className="px-1 text-xs text-muted-foreground">
          <Trans>Active panel content for the selected tab shows here.</Trans>
        </p>
      </div>
    ),
  },
  Mirror: {
    description: msg`Read-only copy of a MirrorSource block from another doc. Edit at the source and it updates live.`,
    render: () => (
      <div className="space-y-1.5">
        <div className="relative rounded-md border border-dashed border-border/40 px-2 py-1.5">
          <span className="absolute -top-2 right-1.5 flex items-center gap-1 rounded-md bg-background px-1 text-[10px] text-muted-foreground">
            <ExternalLink className="size-2.5" aria-hidden="true" />
            <span>
              <Trans>
                Mirror of <code className="font-mono">api-spec</code>
              </Trans>
            </span>
          </span>
          <span className="block h-1.5 w-3/4 rounded-sm bg-muted-foreground/30" />
          <span className="mt-1 block h-1.5 w-2/3 rounded-sm bg-muted-foreground/20" />
        </div>
        <p className="px-1 text-[10px] text-muted-foreground">
          <Trans>Edits at the source land here — no copy-paste drift.</Trans>
        </p>
      </div>
    ),
  },
  MirrorSource: {
    description: msg`Mark a block as the source of truth. Mirrors elsewhere update live as you edit it.`,
    render: () => (
      <div className="space-y-1.5">
        <div className="relative rounded-md border border-dashed border-border/50 px-2 py-1.5">
          <span className="absolute -top-2 left-1.5 flex items-center gap-1 rounded-md bg-background px-1 text-[10px] text-muted-foreground">
            <CopyPlus className="size-2.5" aria-hidden="true" />
            <span>
              <Trans>
                Mirror source <code className="font-mono">api-spec</code>
              </Trans>
            </span>
          </span>
          <span className="block h-1.5 w-4/5 rounded-sm bg-muted-foreground/30" />
          <span className="mt-1 block h-1.5 w-3/5 rounded-sm bg-muted-foreground/20" />
        </div>
        <p className="px-1 text-[10px] text-muted-foreground">
          <Trans>Authoritative content; mirrored verbatim everywhere it's referenced.</Trans>
        </p>
      </div>
    ),
  },
};

function getDefaultProps(descriptor: JsxComponentDescriptor): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const prop of descriptor.props) {
    if (prop.type === 'reactnode') continue;
    if ('defaultValue' in prop && prop.defaultValue !== undefined) {
      defaults[prop.name] = prop.defaultValue;
    }
  }
  return defaults;
}

export function createChildNode(childName: string): Record<string, unknown> {
  const childDesc = getDescriptor(childName);
  const defaultProps = getDefaultProps(childDesc);
  return {
    type: 'jsxComponent',
    attrs: {
      componentName: childDesc.name,
      kind: 'element',
      attributes: [],
      sourceRaw: '',
      sourceDirty: true,
      props: defaultProps,
    },
    content: childDesc.hasChildren ? [{ type: 'paragraph' }] : undefined,
  };
}

const pendingAutoOpen = new Set<number>();

export function setPendingAutoOpen(pos: number): void {
  pendingAutoOpen.add(pos);
}

export function _resetPendingAutoOpenForTest(): void {
  pendingAutoOpen.clear();
}

export function consumeAutoOpen(pos?: number): boolean {
  if (typeof pos === 'number') {
    return pendingAutoOpen.delete(pos);
  }
  const iter = pendingAutoOpen.values().next();
  if (iter.done) return false;
  pendingAutoOpen.delete(iter.value);
  return true;
}

export function focusInsertedComponent(
  editor: Editor,
  insertPos: number,
  descriptor: JsxComponentDescriptor,
): void {
  const hasEditableProps = descriptor.props.some(
    (p) => !('hidden' in p && p.hidden) && p.type !== 'reactnode',
  );

  if (hasEditableProps) {
    setPendingAutoOpen(insertPos);
    requestAnimationFrame(() => {
      editor.commands.setNodeSelection(insertPos);
    });
  } else if (descriptor.hasChildren) {
    editor.commands.setTextSelection(insertPos + 2);
  }
}

function createInsertCommand(descriptor: JsxComponentDescriptor): (editor: Editor) => void {
  return (editor: Editor) => {
    const beforeRefs = new WeakSet<object>();
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'jsxComponent' && node.attrs.componentName === descriptor.name) {
        beforeRefs.add(node);
      }
    });

    const inserted = createChildNode(descriptor.name);
    if (descriptor.name === 'Tabs') {
      const tab1 = createChildNode('Tab');
      const tab2 = createChildNode('Tab');
      const tab1Attrs = tab1.attrs as Record<string, unknown>;
      const tab2Attrs = tab2.attrs as Record<string, unknown>;
      tab1Attrs.props = { ...(tab1Attrs.props as Record<string, unknown>), label: 'Tab 1' };
      tab2Attrs.props = { ...(tab2Attrs.props as Record<string, unknown>), label: 'Tab 2' };
      (inserted as Record<string, unknown>).content = [tab1, tab2];
    }
    editor.chain().focus().insertContent(inserted).run();

    let insertPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (insertPos >= 0) return false;
      if (
        node.type.name === 'jsxComponent' &&
        node.attrs.componentName === descriptor.name &&
        !beforeRefs.has(node)
      ) {
        insertPos = pos;
      }
    });

    if (insertPos < 0) return;
    focusInsertedComponent(editor, insertPos, descriptor);
  };
}

export const SLASH_HIDDEN_CANONICALS: ReadonlySet<string> = new Set(['File', 'Tab']);

function getCustomBlockComponentItems(): SlashCommandItem[] {
  return [
    {
      name: 'component-File',
      label: t`File`,
      icon: FileUp,
      category: 'media',
      aliases: ['file', 'attachment', 'download', 'upload', 'document', 'doc', 'docx', 'zip'],
      description: 'Attach a downloadable file (`.pdf` / `.docx` / `.zip` / …)',
      command: openFilePickerAndUpload,
      preview: {
        description: t`Notion-style inline row for a downloadable file. Drag-drop also works.`,
        render: () => (
          <div className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5">
            <FileUp className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate font-medium text-foreground">quarterly-report.pdf</span>
            <span className="shrink-0 text-xs text-muted-foreground">1.4 MB</span>
          </div>
        ),
      },
    },
  ];
}

export function getComponentItems(): SlashCommandItem[] {
  const descriptors = getRegisteredDescriptors().filter(
    (desc) => desc.surface === 'canonical' && !SLASH_HIDDEN_CANONICALS.has(desc.name),
  );

  const descriptorItems = descriptors.map((desc) => {
    const config = PREVIEW_CONFIG[desc.name];
    const Component = desc.Component;
    const preview: SlashCommandItem['preview'] = config
      ? {
          description: t(config.description),
          render:
            config.render ?? (() => <Component {...config.props}>{config.children}</Component>),
        }
      : undefined;

    return {
      name: `component-${desc.name}`,
      label: desc.displayName ?? desc.name,
      icon: resolveIcon(desc.icon),
      category: desc.category ?? 'content',
      command: createInsertCommand(desc),
      aliases: desc.searchTerms,
      description: desc.description,
      preview,
    };
  });

  return [...descriptorItems, ...getCustomBlockComponentItems()];
}

function openFilePickerAndUpload(editor: Editor): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '*/*';
  input.style.display = 'none';
  input.addEventListener(
    'change',
    () => {
      const file = input.files?.[0];
      if (file) {
        const insertPos = editor.state.selection.from;
        void uploadAndInsert(file, editor, insertPos);
      }
      input.remove();
    },
    { once: true },
  );
  input.addEventListener('cancel', () => input.remove(), { once: true });
  document.body.appendChild(input);
  input.click();
}

function findLinkMarkIdAt(editor: Editor, pos: number): string | null {
  const state = markIdentityKey.getState(editor.state);
  if (!state) return null;
  for (const info of state.byId.values()) {
    if (info.markType === 'link' && info.from <= pos && pos < info.to) {
      return info.id;
    }
  }
  return null;
}

export function getInlineComponentItems(): SlashCommandItem[] {
  return [
    {
      name: 'link',
      label: t`Link`,
      icon: Link2,
      category: 'insert',
      aliases: [
        'url',
        'href',
        'external',
        'web',
        'hyperlink',
        'wiki',
        'wikilink',
        '[[',
        'internal',
        'page',
        'backlink',
        'cross-link',
      ],
      description: 'Link to a page or external URL',
      preview: {
        description: t`Link to a page or external URL.`,
        render: () => (
          <p className="leading-7 text-sm">
            <Trans>
              See{' '}
              <span className="font-medium text-azure-blue underline underline-offset-2 dark:text-sky-blue">
                Architecture
              </span>{' '}
              for the system overview.
            </Trans>
          </p>
        ),
      },
      command: (editor: Editor) => {
        const insertPos = editor.state.selection.from;
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'text',
            text: 'link',
            marks: [{ type: 'link', attrs: { href: '' } }],
          })
          .run();

        const markId = findLinkMarkIdAt(editor, insertPos);
        if (!markId) return;
        setPendingLinkEdit(markId);
        requestAnimationFrame(() => {
          getInteractionLayer(editor).setActiveNode(markId);
        });
      },
    },
    {
      name: 'component-Tag',
      label: t`Tag`,
      icon: Hash,
      category: 'content',
      aliases: ['#', 'hashtag', 'label'],
      description: 'Inline tag (`#tagname`) for cross-doc linking',
      preview: {
        description: t`Inline hashtag for cross-doc grouping.`,
        render: () => (
          <p className="text-sm leading-7">
            <Trans>
              See{' '}
              {/* biome-ignore lint/a11y/useValidAnchor: preview mockup of an <a className="tag"> — no real navigation target needed inside the slash menu's pointer-events-none preview frame */}
              <a className="tag pointer-events-none">#design-docs</a> for the latest specs.
            </Trans>
          </p>
        ),
      },
      command: (editor: Editor) => {
        editor.chain().insertTag('').run();
      },
    },
  ];
}

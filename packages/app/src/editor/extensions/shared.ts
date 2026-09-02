import { sharedExtensions as coreExtensions } from '@inkeep/open-knowledge-core';
import { Extension } from '@tiptap/core';
import FileHandler from '@tiptap/extension-file-handler';
import { KeyboardNav } from '../block-ux/keyboard-nav';
import { TiptapFindReplace } from '../find-replace/tiptap-find-replace-extension';
import { GfmAutolink } from '../gfm-autolink-plugin';
import { uploadAndInsert } from '../image-upload/index.ts';
import { InlineLinkInputRule } from '../inline-link-input-rule';
import { MathInputRule } from '../math-input-rule';
import { LandingFlash } from '../plugins/landing-flash-wysiwyg';
import { getComponentItems, getInlineComponentItems } from '../slash-command/component-items';
import { getEmbedStarterItems } from '../slash-command/embed-starter-items';
import { getSlashCommandItems } from '../slash-command/items';
import { getSkillReferenceItems } from '../slash-command/skill-reference-items';

import { BlockMover } from './block-mover';
import { BridgeIdPlugin } from './bridge-id-plugin';
import { CellInsertionGate } from './cell-insertion-gate';
import { chunkWrapperDecorationPlugin } from './chunk-wrapper-decoration';
import { CodeBlockFidelity } from './code-block';
import { BlockDragHandle } from './drag-handle';
import { FootnoteAnchorScroll } from './footnote-anchor-scroll';
import { FormattingShortcuts } from './formatting-shortcuts';
import { HeadingAnchors } from './heading-anchors';
import { ImageInlineZoom } from './image-inline-zoom';
import { ImageReference } from './image-reference';
import { InternalLink } from './internal-link';
import { JsxComponent } from './jsx-component';
import { JsxInline } from './jsx-inline';
import { MathInline } from './math-inline';
import { RawMdxFallback } from './raw-mdx-fallback';
import { SelectionStatePlugin } from './selection-state-plugin';
import { SlashCommand } from './slash-command';
import { SourceDirtyObserver } from './source-dirty-observer';
import { TabFocusTrap } from './tab-focus-trap';
import { TableInsertControls } from './table-insert-controls';
import { TableRowEnter } from './table-row-enter';
import { TagClickPlugin } from './tag-click-plugin';
import { Tag } from './tag-view';
import { WikiLink } from './wiki-link';
import { WikiLinkEmbed } from './wiki-link-embed';

export const SLASH_ITEM_SOURCES = [
  getSlashCommandItems,
  getComponentItems,
  getEmbedStarterItems,
  getInlineComponentItems,
] as const;

export const sharedExtensions = [
  ...coreExtensions.map((ext) => {
    if (ext.name === 'jsxComponent') return JsxComponent;
    if (ext.name === 'jsxInline') return JsxInline;
    if (ext.name === 'image') {
      const coreOptions = (ext as unknown as { options?: Record<string, unknown> }).options ?? {};
      return ImageInlineZoom.configure({ ...coreOptions, inline: true });
    }
    if (ext.name === 'imageReference') return ImageReference;
    if (ext.name === 'rawMdxFallback') return RawMdxFallback;
    if (ext.name === 'wikiLink') return WikiLink;
    if (ext.name === 'wikiLinkEmbed') return WikiLinkEmbed;
    if (ext.name === 'link') return InternalLink;
    if (ext.name === 'mathInline') return MathInline;
    if (ext.name === 'tag') return Tag;
    if (ext.name === 'codeBlock') return CodeBlockFidelity;
    return ext;
  }),
  CellInsertionGate,
  SlashCommand.configure({
    itemsSources: [...SLASH_ITEM_SOURCES, getSkillReferenceItems],
    categoryLabels: {
      skills: 'Skills',
      content: 'Components',
      layout: 'Layout',
      media: 'Media',
      data: 'Data',
      embed: 'Embeds',
    },
  }),
  FormattingShortcuts,
  TabFocusTrap,
  FileHandler.configure({
    onDrop(editor, files, pos) {
      for (const file of files) {
        uploadAndInsert(file, editor, pos);
      }
    },
    onPaste(editor, files, _html) {
      for (const file of files) {
        uploadAndInsert(file, editor, editor.state.selection.from);
      }
    },
  }),
  HeadingAnchors,
  TiptapFindReplace,
  TagClickPlugin,
  FootnoteAnchorScroll,
  BlockDragHandle,
  BlockMover,
  TableInsertControls,
  TableRowEnter,
  SourceDirtyObserver,
  GfmAutolink,
  InlineLinkInputRule,
  MathInputRule,
  KeyboardNav,
  BridgeIdPlugin,
  SelectionStatePlugin,
  LandingFlash,
  Extension.create({
    name: 'chunkWrapperDecoration',
    addProseMirrorPlugins() {
      return [chunkWrapperDecorationPlugin()];
    },
  }),
];

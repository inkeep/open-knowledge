import {
  collectFootnoteIdentifiers,
  findFootnoteDefinitionInsertPos,
  nextFootnoteIdentifier,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { EditorState } from '@tiptap/pm/state';
import type { ChainedCommands, Editor } from '@tiptap/react';
import {
  Code2,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Sigma,
  Smile,
  Superscript,
  Table2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { setPendingAutoOpen } from './component-items';
import { openEmojiPickerForEditor } from './emoji-picker-event';

export interface SlashCommandContext {
  chain: () => ChainedCommands;

  state: EditorState;

  editor: Editor;

  afterCommit: (fn: () => void) => void;
}

export interface SlashCommandItem {
  name: string;

  label: string;

  icon: React.ComponentType<{ className?: string }>;

  category: string;

  command: (ctx: SlashCommandContext) => void;

  aliases?: string[];

  description?: string;

  insertsBlockComponent?: boolean;

  preview?: {
    description: string;
    render: () => ReactNode;
  };
}

export function getSlashCommandItems(): SlashCommandItem[] {
  return [
    {
      name: 'heading1',
      label: t`Heading 1`,
      icon: Heading1,
      category: 'basic',
      command: ({ chain }) => chain().toggleHeading({ level: 1 }).run(),
      aliases: ['h1'],
      preview: {
        description: t`Big section heading.`,
        render: () => (
          <h1 className="text-2xl font-semibold tracking-tight">
            <Trans>Heading 1</Trans>
          </h1>
        ),
      },
    },
    {
      name: 'heading2',
      label: t`Heading 2`,
      icon: Heading2,
      category: 'basic',
      command: ({ chain }) => chain().toggleHeading({ level: 2 }).run(),
      aliases: ['h2'],
      preview: {
        description: t`Medium section heading.`,
        render: () => (
          <h2 className="text-xl font-semibold tracking-tight">
            <Trans>Heading 2</Trans>
          </h2>
        ),
      },
    },
    {
      name: 'heading3',
      label: t`Heading 3`,
      icon: Heading3,
      category: 'basic',
      command: ({ chain }) => chain().toggleHeading({ level: 3 }).run(),
      aliases: ['h3'],
      preview: {
        description: t`Small section heading.`,
        render: () => (
          <h3 className="text-base font-semibold tracking-tight">
            <Trans>Heading 3</Trans>
          </h3>
        ),
      },
    },
    {
      name: 'bulletList',
      label: t`Bullet List`,
      icon: List,
      category: 'basic',
      command: ({ chain }) => chain().toggleBulletList().run(),
      aliases: ['ul', 'unordered'],
      preview: {
        description: t`Unordered list of items.`,
        render: () => (
          <ul className="list-disc pl-5 text-sm leading-7">
            <li>
              <Trans>First item</Trans>
            </li>
            <li>
              <Trans>Second item</Trans>
            </li>
          </ul>
        ),
      },
    },
    {
      name: 'orderedList',
      label: t`Ordered List`,
      icon: ListOrdered,
      category: 'basic',
      command: ({ chain }) => chain().toggleOrderedList().run(),
      aliases: ['ol', 'numbered'],
      preview: {
        description: t`Numbered list of items.`,
        render: () => (
          <ol className="list-decimal pl-5 text-sm leading-7">
            <li>
              <Trans>First item</Trans>
            </li>
            <li>
              <Trans>Second item</Trans>
            </li>
          </ol>
        ),
      },
    },
    {
      name: 'taskList',
      label: t`Task List`,
      icon: ListTodo,
      category: 'basic',
      command: ({ chain }) => chain().toggleTaskList().run(),
      aliases: ['todo', 'checklist', 'checkbox'],
      preview: {
        description: t`Checklist with checkboxes.`,
        render: () => (
          <ul className="space-y-1.5 text-sm">
            <li className="flex items-center gap-2">
              <input type="checkbox" checked readOnly className="size-3.5" />
              <span className="text-muted-foreground line-through">
                <Trans>Done</Trans>
              </span>
            </li>
            <li className="flex items-center gap-2">
              <input type="checkbox" readOnly className="size-3.5" />
              <span>
                <Trans>To do</Trans>
              </span>
            </li>
          </ul>
        ),
      },
    },
    {
      name: 'blockquote',
      label: t`Quote`,
      icon: Quote,
      category: 'basic',
      command: ({ chain }) => chain().toggleBlockquote().run(),
      aliases: ['quote'],
      preview: {
        description: t`Indented blockquote for citations.`,
        render: () => (
          <blockquote className="border-l-2 border-muted-foreground/40 pl-3 text-sm italic text-muted-foreground">
            <Trans>A pull quote stands out from the surrounding text.</Trans>
          </blockquote>
        ),
      },
    },
    {
      name: 'codeBlock',
      label: t`Code Block`,
      icon: Code2,
      category: 'basic',
      command: ({ chain }) => chain().toggleCodeBlock({ language: 'js' }).run(),
      aliases: ['code', 'fence'],
      preview: {
        description: t`Fenced code block with monospace text.`,
        render: () => (
          <pre className="rounded-md bg-muted px-2.5 py-2 font-mono text-xs leading-5">
            <code>{'const greeting = "Hello";\nconsole.log(greeting);'}</code>
          </pre>
        ),
      },
    },
    {
      name: 'table',
      label: t`Table`,
      icon: Table2,
      category: 'insert',
      command: ({ chain }) => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      aliases: ['grid'],
      preview: {
        description: t`Grid of rows and columns with a header row.`,
        render: () => (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">
                  <Trans>Name</Trans>
                </th>
                <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">
                  <Trans>Role</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-border px-2 py-1">Ada</td>
                <td className="border border-border px-2 py-1">Engineer</td>
              </tr>
              <tr>
                <td className="border border-border px-2 py-1">Grace</td>
                <td className="border border-border px-2 py-1">Admiral</td>
              </tr>
            </tbody>
          </table>
        ),
      },
    },
    {
      name: 'separator',
      label: t`Separator`,
      icon: Minus,
      category: 'insert',
      command: ({ chain }) => chain().setHorizontalRule().run(),
      aliases: ['hr', 'divider', 'rule'],
      preview: {
        description: t`Horizontal rule that divides sections.`,
        render: () => (
          <div className="w-full">
            <p className="mb-2 text-xs text-muted-foreground">
              <Trans>Above</Trans>
            </p>
            <hr className="border-border" />
            <p className="mt-2 text-xs text-muted-foreground">
              <Trans>Below</Trans>
            </p>
          </div>
        ),
      },
    },
    {
      name: 'footnote',
      label: t`Footnote`,
      icon: Superscript,
      category: 'insert',
      command: ({ chain, state }) => {
        const next = nextFootnoteIdentifier(collectFootnoteIdentifiers(state.doc));
        const insertAt = findFootnoteDefinitionInsertPos(state.doc) + 1;
        chain()
          .insertFootnoteReference(next)
          .insertContentAt(insertAt, {
            type: 'footnoteDefinition',
            attrs: { identifier: next, label: next },
            content: [{ type: 'paragraph' }],
          })
          .run();
      },
      aliases: ['fn', 'ref', '[^'],
      preview: {
        description: t`Insert a footnote reference + matching definition stub.`,
        render: () => (
          <p className="text-sm leading-6">
            <Trans>
              A line with a footnote
              <sup className="footnote-ref">
                <a className="footnote-ref-link" href="#fn-1">
                  [1]
                </a>
              </sup>{' '}
              and a definition shown below.
            </Trans>
          </p>
        ),
      },
    },
    {
      name: 'emoji',
      label: t`Emoji`,
      icon: Smile,
      category: 'insert',
      command: ({ editor, afterCommit }) => {
        afterCommit(() => openEmojiPickerForEditor({ editor }));
      },
      aliases: [':', 'emoticon', 'smiley', 'face', 'reaction'],
      preview: {
        description: t`Pick an emoji to insert at the cursor.`,
        render: () => <p className="text-2xl leading-8">🎉 🚀 ✅ ❤️ 👀</p>,
      },
    },
    {
      name: 'inlineMath',
      label: t`Inline Math`,
      icon: Sigma,
      category: 'insert',
      command: ({ chain, state, editor, afterCommit }) => {
        const insertPos = state.selection.from;
        chain().insertMathInline('').run();
        afterCommit(() => {
          setPendingAutoOpen(insertPos);
          requestAnimationFrame(() => {
            editor.commands.setNodeSelection(insertPos);
          });
        });
      },
      aliases: ['math', 'latex', 'equation', 'formula', 'katex', 'inlinemath'],
      preview: {
        description: t`Inline LaTeX math rendered with KaTeX.`,
        render: () => (
          <p className="text-sm leading-7">
            <Trans>
              The formula{' '}
              <span className="rounded bg-muted px-1.5 py-0.5 font-serif italic">
                c = √(a² + b²)
              </span>{' '}
              renders inline.
            </Trans>
          </p>
        ),
      },
    },
  ];
}

export function filterItems(items: SlashCommandItem[], query: string): SlashCommandItem[] {
  if (!query) return items;
  const lower = query.toLowerCase();
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(lower) ||
      item.name.toLowerCase().includes(lower) ||
      item.aliases?.some((a) => a.toLowerCase().includes(lower)),
  );
}

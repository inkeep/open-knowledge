import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import {
  ChevronDown,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Pilcrow,
  Quote,
  SquareCode,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface BlockType {
  name: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  isActive: (editor: Editor) => boolean;
  command: (editor: Editor) => void;
}

const blockTypes: BlockType[] = [
  {
    name: 'paragraph',
    label: 'Text',
    icon: Pilcrow,
    isActive: (editor) => editor.isActive('paragraph') && !editor.isActive('list'),
    command: (editor) => editor.chain().focus().setParagraph().run(),
  },
  {
    name: 'heading1',
    label: 'Heading 1',
    icon: Heading1,
    isActive: (editor) => editor.isActive('heading', { level: 1 }),
    command: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    name: 'heading2',
    label: 'Heading 2',
    icon: Heading2,
    isActive: (editor) => editor.isActive('heading', { level: 2 }),
    command: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    name: 'heading3',
    label: 'Heading 3',
    icon: Heading3,
    isActive: (editor) => editor.isActive('heading', { level: 3 }),
    command: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    name: 'bulletList',
    label: 'Bullet List',
    icon: List,
    isActive: (editor) =>
      editor.isActive('list', { ordered: false }) &&
      !editor.isActive('listItem', { checked: true }) &&
      !editor.isActive('listItem', { checked: false }),
    command: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    name: 'orderedList',
    label: 'Ordered List',
    icon: ListOrdered,
    isActive: (editor) => editor.isActive('list', { ordered: true }),
    command: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    name: 'taskList',
    label: 'Task List',
    icon: ListTodo,
    isActive: (editor) =>
      editor.isActive('listItem', { checked: true }) ||
      editor.isActive('listItem', { checked: false }),
    command: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    name: 'blockquote',
    label: 'Quote',
    icon: Quote,
    isActive: (editor) => editor.isActive('blockquote'),
    command: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    name: 'codeBlock',
    label: 'Code Block',
    icon: SquareCode,
    isActive: (editor) => editor.isActive('codeBlock'),
    // Default to JavaScript at creation so syntax highlighting fires on
    // the first character. The default lives here (and on the sibling
    // bare-backticks input rule + slash menu) rather than as a schema
    // default — the y-tiptap bridge would otherwise migrate parsed-from-
    // disk bare fences. See `extensions/code-block.ts`'s top-of-file
    // comment for the bridge mechanics.
    command: (editor) => editor.chain().focus().toggleCodeBlock({ language: 'js' }).run(),
  },
];

export function BlockTypeSelector({ editor }: { editor: Editor }) {
  const { current, activeStates } = useEditorState({
    editor,
    selector: (ctx) => {
      const activeStates = Object.fromEntries(
        blockTypes.map((bt) => [bt.name, bt.isActive(ctx.editor)]),
      );
      const current = blockTypes.find((bt) => activeStates[bt.name]) ?? blockTypes[0];
      return { current, activeStates };
    },
  });
  const CurrentIcon = current.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 px-2 text-sm font-medium text-accent-foreground/80"
        >
          <CurrentIcon className="size-3.5" />
          <span>{current.label}</span>
          <ChevronDown className="size-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={8}
        className="w-44 max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto subtle-scrollbar"
      >
        {blockTypes.map((bt) => {
          const Icon = bt.icon;
          const active = activeStates[bt.name];
          return (
            <DropdownMenuItem
              key={bt.name}
              className={active ? 'bg-accent text-accent-foreground' : ''}
              onSelect={() => {
                bt.command(editor);
              }}
            >
              <Icon className="size-4" />
              <span>{bt.label}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

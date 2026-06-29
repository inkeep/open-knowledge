
import { autoUpdate, computePosition, offset } from '@floating-ui/dom';
import type { Editor } from '@tiptap/react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns3,
  Ellipsis,
  EllipsisVertical,
  Grid2x2X,
  type LucideIcon,
  TableProperties,
  Trash2,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getFindReplaceState } from '../find-replace/tiptap-find-replace-extension';

type Axis = 'column' | 'row';

interface ActiveCell {
  columnAnchor: HTMLElement;
  rowAnchor: HTMLElement;
  isFirstColumn: boolean;
  isFirstRow: boolean;
}

interface MenuItem {
  label: string;
  icon: LucideIcon;
  run: (editor: Editor) => void;
  separatorBefore?: boolean;
}

function columnItems(showHeaderToggle: boolean): MenuItem[] {
  return [
    ...(showHeaderToggle
      ? [
          {
            label: 'Toggle header column',
            icon: Columns3,
            run: (e: Editor) => e.chain().focus().toggleHeaderColumn().run(),
          },
        ]
      : []),
    {
      label: 'Insert column left',
      icon: ArrowLeft,
      run: (e) => e.chain().focus().addColumnBefore().run(),
    },
    {
      label: 'Insert column right',
      icon: ArrowRight,
      run: (e) => e.chain().focus().addColumnAfter().run(),
    },
    {
      label: 'Delete column',
      icon: Trash2,
      separatorBefore: true,
      run: (e) => e.chain().focus().deleteColumn().run(),
    },
    { label: 'Delete table', icon: Grid2x2X, run: (e) => e.chain().focus().deleteTable().run() },
  ];
}

function rowItems(showHeaderToggle: boolean): MenuItem[] {
  return [
    ...(showHeaderToggle
      ? [
          {
            label: 'Toggle header row',
            icon: TableProperties,
            run: (e: Editor) => e.chain().focus().toggleHeaderRow().run(),
          },
        ]
      : []),
    {
      label: 'Insert row above',
      icon: ArrowUp,
      run: (e) => e.chain().focus().addRowBefore().run(),
    },
    {
      label: 'Insert row below',
      icon: ArrowDown,
      run: (e) => e.chain().focus().addRowAfter().run(),
    },
    {
      label: 'Delete row',
      icon: Trash2,
      separatorBefore: true,
      run: (e) => e.chain().focus().deleteRow().run(),
    },
    { label: 'Delete table', icon: Grid2x2X, run: (e) => e.chain().focus().deleteTable().run() },
  ];
}

function computeActiveCell(editor: Editor): ActiveCell | null {
  if (!editor.isEditable) return null;
  if (getFindReplaceState(editor.state).query) return null;

  const { state, view } = editor;
  const $from = state.selection.$from;
  let cellPos = -1;
  for (let depth = $from.depth; depth > 0; depth--) {
    const role = $from.node(depth).type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell') {
      cellPos = $from.before(depth);
      break;
    }
  }
  if (cellPos < 0) return null;

  const cellDOM = view.nodeDOM(cellPos);
  if (!(cellDOM instanceof HTMLTableCellElement)) return null;
  const table = cellDOM.closest('table');
  const tr = cellDOM.closest('tr');
  const inEditor = cellDOM.closest('.ProseMirror');
  if (!table || !tr || !inEditor) return null;

  const rowIndex = Array.prototype.indexOf.call(table.rows, tr);
  const colIndex = cellDOM.cellIndex;
  const columnAnchor = table.rows[0]?.cells[colIndex];
  const rowAnchor = table.rows[rowIndex]?.cells[0];
  if (!columnAnchor || !rowAnchor) return null;

  return {
    columnAnchor,
    rowAnchor,
    isFirstColumn: colIndex === 0,
    isFirstRow: rowIndex === 0,
  };
}

function CellHandle({
  editor,
  anchor,
  axis,
  items,
}: {
  editor: Editor;
  anchor: HTMLElement;
  axis: Axis;
  items: MenuItem[];
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const placement = axis === 'column' ? 'top' : 'left';
    const overlap = axis === 'column' ? -14 : -6;
    const update = () => {
      void computePosition(anchor, el, {
        strategy: 'absolute',
        placement,
        middleware: [offset(overlap)],
      })
        .then(({ x, y }) => {
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
          el.style.opacity = '1';
        })
        .catch(() => {});
    };
    return autoUpdate(anchor, el, update);
  }, [anchor, axis]);

  const HandleIcon = axis === 'column' ? Ellipsis : EllipsisVertical;

  return (
    <div ref={ref} data-testid="table-cell-handle" className="absolute left-0 top-0 z-10 opacity-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            className={
              axis === 'column'
                ? 'h-3 w-7 rounded-full p-0 text-gray-700 dark:text-muted-foreground bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 hover:text-foreground dark:hover:bg-gray-600 dark:hover:text-gray-100 relative before:absolute before:-inset-[6px] before:content-[""]'
                : 'h-7 w-3 rounded-full p-0 text-gray-700 dark:text-muted-foreground bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 hover:text-foreground dark:hover:bg-gray-600 dark:hover:text-gray-100 relative before:absolute before:-inset-[6px] before:content-[""]'
            }
            aria-label={axis === 'column' ? 'Column options' : 'Row options'}
          >
            <HandleIcon className="size-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={axis === 'column' ? 'center' : 'start'}
          side={axis === 'column' ? 'bottom' : 'right'}
          className="w-auto min-w-44 whitespace-nowrap"
        >
          {items.map((item) => (
            <Fragment key={item.label}>
              {item.separatorBefore && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => item.run(editor)}>
                <item.icon aria-hidden />
                {item.label}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function TableCellHandles({ editor }: { editor: Editor }) {
  const [active, setActive] = useState<ActiveCell | null>(null);

  useEffect(() => {
    const update = () =>
      setActive((prev) => {
        const next = computeActiveCell(editor);
        if (
          prev &&
          next &&
          prev.columnAnchor === next.columnAnchor &&
          prev.rowAnchor === next.rowAnchor
        ) {
          return prev;
        }
        return next;
      });
    update();
    editor.on('selectionUpdate', update);
    editor.on('update', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('update', update);
    };
  }, [editor]);

  if (!active) return null;

  return (
    <div className="ok-table-cell-handle-layer">
      <CellHandle
        editor={editor}
        anchor={active.columnAnchor}
        axis="column"
        items={columnItems(active.isFirstColumn)}
      />
      <CellHandle
        editor={editor}
        anchor={active.rowAnchor}
        axis="row"
        items={rowItems(active.isFirstRow)}
      />
    </div>
  );
}

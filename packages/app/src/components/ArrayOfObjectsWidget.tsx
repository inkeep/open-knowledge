/**
 * CRUD widget for arrays whose every element is a plain object (e.g.
 * `contributors: [{ name, role }, ...]`). Outer Collapsible mirrors
 * {@link ObjectWidget}; inside, each item renders as its own indexed
 * section with a drag-handle + delete and a recursive `ObjectWidget` for
 * the item's fields. Item-level mutations route through the binding's
 * LOCAL path API:
 *   - add item → `binding.patchPath([...path, currentLength], {})`
 *   - delete item → `binding.deletePath([...path, idx])` (yaml@2 splices)
 *   - reorder items → `binding.reorderSeqPath(path, oldIndicesInNewOrder)`
 * Field-level mutations within each item flow through the nested
 * `ObjectWidget` and reach the binding at `[...path, idx, fieldKey]`.
 *
 * Per-item index identity. Sortable IDs are positional (`item-${idx}`)
 * because array items have no stable keys. Index-as-React-key is
 * intentional here — items are addressed by index throughout the binding
 * path API, and reorder/delete operations refresh the whole list anyway.
 */

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { FrontmatterValue } from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight, GripVertical, Plus, Trash2 } from 'lucide-react';
import { type CSSProperties, useState } from 'react';
import { useFrontmatterBinding } from '@/components/FrontmatterBindingContext';
import { describeError } from '@/components/frontmatter-error-utils';
import { ObjectWidget } from '@/components/ObjectWidget';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

type ObjectItem = { [key: string]: FrontmatterValue };

interface ArrayOfObjectsWidgetProps {
  keyName: string;
  value: ReadonlyArray<ObjectItem>;
  path: ReadonlyArray<string | number>;
  depth?: number;
}

export function ArrayOfObjectsWidget({
  keyName,
  value,
  path,
  depth = 0,
}: ArrayOfObjectsWidgetProps) {
  const { t } = useLingui();
  const binding = useFrontmatterBinding();
  const [open, setOpen] = useState(depth === 0);
  const [itemErrors, setItemErrors] = useState<Record<number, string>>({});
  const [addError, setAddError] = useState<string | null>(null);

  const triggerLabel = open ? t`Collapse ${keyName}` : t`Expand ${keyName}`;
  const readOnly = binding === null;

  function pathOfItem(idx: number): ReadonlyArray<string | number> {
    return [...path, idx];
  }

  function clearItemError(idx: number) {
    setItemErrors((prev) => {
      if (!Object.hasOwn(prev, idx)) return prev;
      const next = { ...prev };
      delete next[idx];
      return next;
    });
  }

  function applyItemError(idx: number, message: string) {
    setItemErrors((prev) => ({ ...prev, [idx]: message }));
  }

  function removeItem(idx: number) {
    if (!binding) return;
    clearItemError(idx);
    // Removing the final item would leave a bare `[]`, which is type-ambiguous
    // (empty scalar array vs empty object array) and re-dispatches to the
    // scalar chip widget — a dead-end with no way to add object items back.
    // Drop the whole property instead so the row clears cleanly.
    const result =
      value.length <= 1 ? binding.deletePath(path) : binding.deletePath(pathOfItem(idx));
    if (result.ok) {
      // Remaining items shift down a slot; positional `itemErrors` keys would
      // now point at the wrong items. They are transient last-commit-failed
      // markers, so drop them all rather than attempt a fragile remap.
      setItemErrors({});
      return;
    }
    const message = describeError(result.error, String(idx), t`Failed to delete item`);
    applyItemError(idx, message);
  }

  function addItem() {
    if (!binding) return;
    setAddError(null);
    const result = binding.patchPath(pathOfItem(value.length), {});
    if (result.ok) return;
    const message = describeError(result.error, String(value.length), t`Failed to add item`);
    setAddError(message);
  }

  function sortableItemId(idx: number): string {
    return `${path.join('.')}::item::${idx}`;
  }

  function handleDragEnd(event: DragEndEvent): void {
    if (!binding) return;
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) return;

    const ids = value.map((_, i) => sortableItemId(i));
    const oldIndex = ids.indexOf(activeId);
    const newIndex = ids.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return;

    const want = value.map((_, i) => i);
    const [moved] = want.splice(oldIndex, 1);
    if (moved === undefined) return;
    want.splice(newIndex, 0, moved);

    const result = binding.reorderSeqPath(path, want);
    if (result.ok) {
      // Positions changed; positional `itemErrors` keys would misalign. Drop
      // the transient markers rather than remap them to new slots.
      setItemErrors({});
      return;
    }
    const message = describeError(result.error, String(oldIndex), t`Failed to reorder`);
    applyItemError(oldIndex, message);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  return (
    <div
      data-testid="array-of-objects-widget"
      data-key={keyName}
      data-depth={depth}
      data-read-only={readOnly || undefined}
      className="w-full min-w-0"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="array-of-objects-widget-trigger"
            data-key={keyName}
            data-state-open={open ? 'true' : 'false'}
            aria-label={triggerLabel}
            className="h-7 w-full justify-start gap-1 px-2 font-normal hover:bg-muted"
          >
            <ChevronRight
              data-expanded={open}
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out data-[expanded=true]:rotate-90"
            />
            <span className="truncate text-xs text-muted-foreground">
              {value.length === 0 ? (
                <Trans>empty</Trans>
              ) : (
                <Plural value={value.length} one="# item" other="# items" />
              )}
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-[collapsible-down_150ms_ease-out] data-[state=closed]:animate-[collapsible-up_150ms_ease-in]">
          <div
            data-testid="array-of-objects-widget-children"
            data-key={keyName}
            className="mt-0.5 ml-2 border-l border-border/60 pl-2"
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={value.map((_, i) => sortableItemId(i))}
                strategy={verticalListSortingStrategy}
              >
                {value.map((item, idx) => (
                  <ArrayItemRow
                    /* biome-ignore lint/suspicious/noArrayIndexKey: items are addressed by index across the binding path API; remount-on-reorder is correct. */
                    key={idx}
                    sortableId={readOnly ? undefined : sortableItemId(idx)}
                    arrayKey={keyName}
                    index={idx}
                    value={item}
                    path={pathOfItem(idx)}
                    error={itemErrors[idx] ?? null}
                    onRemove={readOnly ? undefined : () => removeItem(idx)}
                  />
                ))}
              </SortableContext>
            </DndContext>
            {readOnly ? null : (
              <div className="mt-1 flex items-center gap-1">
                <span aria-hidden className="h-7 w-4 shrink-0" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="array-of-objects-widget-add-trigger"
                  data-key={keyName}
                  onClick={addItem}
                  aria-label={t`Add item to ${keyName}`}
                  className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium hover:bg-muted/50 hover:text-foreground"
                >
                  <Plus className="size-3.5" />
                  <span>
                    <Trans>Add item</Trans>
                  </span>
                </Button>
                {addError ? (
                  <span
                    role="alert"
                    data-testid="array-of-objects-add-error"
                    data-key={keyName}
                    className="text-[10px] text-destructive"
                  >
                    {addError}
                  </span>
                ) : null}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

interface ArrayItemRowProps {
  sortableId: string | undefined;
  arrayKey: string;
  index: number;
  value: ObjectItem;
  path: ReadonlyArray<string | number>;
  error: string | null;
  onRemove: (() => void) | undefined;
}

function ArrayItemRow({
  sortableId,
  arrayKey,
  index,
  value,
  path,
  error,
  onRemove,
}: ArrayItemRowProps) {
  if (sortableId) {
    return (
      <SortableItemShell
        sortableId={sortableId}
        arrayKey={arrayKey}
        index={index}
        value={value}
        path={path}
        error={error}
        onRemove={onRemove}
      />
    );
  }
  return (
    <StaticItemShell
      arrayKey={arrayKey}
      index={index}
      value={value}
      path={path}
      error={error}
      onRemove={onRemove}
    />
  );
}

function SortableItemShell({
  sortableId,
  arrayKey,
  index,
  value,
  path,
  error,
  onRemove,
}: ArrayItemRowProps & { sortableId: string }) {
  const { t } = useLingui();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 1 : undefined,
  };
  const dragHandle = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-testid="array-item-drag-handle"
      data-key={arrayKey}
      data-index={index}
      aria-label={t`Drag item ${index + 1} to reorder`}
      {...attributes}
      {...listeners}
      className="h-7 w-4 shrink-0 cursor-grab touch-none px-0 text-muted-foreground/0 hover:text-foreground focus-visible:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing group-hover:text-muted-foreground/60"
    >
      <GripVertical className="size-3.5" />
    </Button>
  );
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group mt-1 rounded border border-border/40 p-1"
      data-testid="array-item"
      data-key={arrayKey}
      data-index={index}
      data-dragging={isDragging || undefined}
      data-error={error ?? undefined}
    >
      <ArrayItemBody
        dragHandle={dragHandle}
        arrayKey={arrayKey}
        index={index}
        value={value}
        path={path}
        error={error}
        onRemove={onRemove}
      />
    </div>
  );
}

function StaticItemShell({
  arrayKey,
  index,
  value,
  path,
  error,
  onRemove,
}: Omit<ArrayItemRowProps, 'sortableId'>) {
  return (
    <div
      className="group mt-1 rounded border border-border/40 p-1"
      data-testid="array-item"
      data-key={arrayKey}
      data-index={index}
      data-error={error ?? undefined}
    >
      <ArrayItemBody
        dragHandle={null}
        arrayKey={arrayKey}
        index={index}
        value={value}
        path={path}
        error={error}
        onRemove={onRemove}
      />
    </div>
  );
}

function ArrayItemBody({
  dragHandle,
  arrayKey,
  index,
  value,
  path,
  error,
  onRemove,
}: {
  dragHandle: React.ReactNode;
  arrayKey: string;
  index: number;
  value: ObjectItem;
  path: ReadonlyArray<string | number>;
  error: string | null;
  onRemove: (() => void) | undefined;
}) {
  const { t } = useLingui();
  const indexLabel = t`Item ${index + 1}`;
  return (
    <>
      <div className="flex items-center gap-1">
        {dragHandle}
        <span
          data-testid="array-item-label"
          data-key={arrayKey}
          data-index={index}
          className="flex-1 truncate text-xs font-medium text-muted-foreground"
        >
          {indexLabel}
        </span>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="array-item-remove"
            data-key={arrayKey}
            data-index={index}
            aria-label={t`Remove item ${index + 1}`}
            onClick={onRemove}
            className="shrink-0 rounded text-muted-foreground/0 hover:bg-muted hover:text-foreground focus-visible:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:text-muted-foreground"
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="mt-0.5">
        <ObjectWidget keyName={`${arrayKey}[${index}]`} value={value} path={path} depth={0} />
      </div>
      {error ? (
        <div
          role="alert"
          data-testid="array-item-error"
          data-key={arrayKey}
          data-index={index}
          className="pl-2 text-[10px] text-destructive"
        >
          {error}
        </div>
      ) : null}
    </>
  );
}

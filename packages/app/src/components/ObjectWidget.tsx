
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
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  type FrontmatterType,
  type FrontmatterValue,
  frontmatterValuesEqual,
  inferType,
  RESERVED_FRONTMATTER_KEY,
} from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { useFrontmatterBinding } from '@/components/FrontmatterBindingContext';
import {
  type AddDraft,
  AddPropertyRow,
  FrontmatterRow,
  type RenameDraft,
} from '@/components/FrontmatterRow';
import { describeError } from '@/components/frontmatter-error-utils';
import { coerceValue, DEFAULT_VALUE_FOR_TYPE } from '@/components/PropertyWidgets';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface ObjectWidgetProps {
  keyName: string;
  value: { [key: string]: FrontmatterValue };
  path: ReadonlyArray<string | number>;
  depth?: number;
}

export function ObjectWidget({ keyName, value, path, depth = 0 }: ObjectWidgetProps) {
  const { t } = useLingui();
  const binding = useFrontmatterBinding();
  const [open, setOpen] = useState(depth === 0);
  const [renaming, setRenaming] = useState<RenameDraft | null>(null);
  const [adding, setAdding] = useState<AddDraft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [resetCounters, setResetCounters] = useState<Record<string, number>>({});

  const entries = Object.entries(value);
  const triggerLabel = open ? t`Collapse ${keyName}` : t`Expand ${keyName}`;
  const readOnly = binding === null;

  function clearError(key: string) {
    setErrors((prev) => {
      if (!Object.hasOwn(prev, key)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function applyError(key: string, message: string) {
    setErrors((prev) => ({ ...prev, [key]: message }));
    setResetCounters((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  }

  function pathOf(childKey: string): ReadonlyArray<string | number> {
    return [...path, childKey];
  }

  function commitChild(childKey: string, nextValue: FrontmatterValue) {
    if (!binding) return;
    clearError(childKey);
    const result = binding.patchPath(pathOf(childKey), nextValue);
    if (result.ok) return;
    const message = describeError(result.error, childKey, t`Failed to update property`);
    applyError(childKey, message);
  }

  function removeChild(childKey: string) {
    if (!binding) return;
    clearError(childKey);
    const result = binding.deletePath(pathOf(childKey));
    if (result.ok) return;
    const message = describeError(result.error, childKey, t`Failed to delete property`);
    applyError(childKey, message);
  }

  function changeChildType(childKey: string, nextType: FrontmatterType) {
    if (!binding) return;
    const current = value[childKey];
    if (current === undefined) return;
    const coerced = coerceValue(current, nextType);
    if (frontmatterValuesEqual(current, coerced)) return;
    commitChild(childKey, coerced);
  }

  function beginChildRename(childKey: string) {
    setRenaming({ key: childKey, draft: childKey, error: null });
  }

  function changeRenameDraft(draft: string) {
    setRenaming((prev) => (prev ? { ...prev, draft, error: null } : prev));
  }

  function cancelRename() {
    setRenaming(null);
  }

  function commitRename() {
    if (!renaming || !binding) return;
    const trimmed = renaming.draft.trim();
    if (!trimmed) {
      setRenaming(null);
      return;
    }
    if (trimmed === renaming.key) {
      setRenaming(null);
      return;
    }
    if (Object.hasOwn(value, trimmed)) {
      setRenaming({ ...renaming, error: t`Property "${trimmed}" already exists` });
      return;
    }
    const result = binding.renamePath(pathOf(renaming.key), trimmed);
    if (result.ok) {
      clearError(renaming.key);
      setRenaming(null);
      return;
    }
    const message = describeError(result.error, trimmed, t`Failed to rename property`);
    setRenaming({ ...renaming, error: message });
  }

  function beginAdd() {
    setAdding({ name: '', type: 'text', value: '', error: null });
  }

  function changeAddName(name: string) {
    setAdding((prev) => (prev ? { ...prev, name, error: null } : prev));
  }

  function changeAddType(nextType: FrontmatterType) {
    setAdding((prev) => {
      if (!prev) return prev;
      const defaultValue =
        nextType === 'date'
          ? new Date().toISOString().slice(0, 10)
          : DEFAULT_VALUE_FOR_TYPE[nextType];
      return { ...prev, type: nextType, value: defaultValue, error: null };
    });
  }

  function changeAddValue(next: FrontmatterValue) {
    setAdding((prev) => (prev ? { ...prev, value: next } : prev));
  }

  function commitAdd() {
    if (!adding || !binding) return;
    const trimmed = adding.name.trim();
    if (!trimmed) {
      setAdding({ ...adding, error: t`Name is required` });
      return;
    }
    if (trimmed === RESERVED_FRONTMATTER_KEY && path.length === 0) {
      setAdding({ ...adding, error: t`"frontmatter" is a reserved property name` });
      return;
    }
    if (Object.hasOwn(value, trimmed)) {
      setAdding({ ...adding, error: t`Property "${trimmed}" already exists` });
      return;
    }
    const result = binding.patchPath(pathOf(trimmed), adding.value);
    if (result.ok) {
      setAdding(null);
      return;
    }
    const message = describeError(result.error, trimmed, t`Failed to add property`);
    setAdding({ ...adding, error: message });
  }

  function cancelAdd() {
    setAdding(null);
  }

  function nestedRowId(childKey: string, idx: number): string {
    return `${path.join('.')}::${childKey}::${idx}`;
  }

  function handleDragEnd(event: DragEndEvent): void {
    if (!binding) return;
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) return;

    const childKeys = entries.map(([k]) => k);
    const ids = childKeys.map((k, i) => nestedRowId(k, i));
    const oldIndex = ids.indexOf(activeId);
    const newIndex = ids.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return;

    const next = childKeys.slice();
    const [moved] = next.splice(oldIndex, 1);
    if (!moved) return;
    next.splice(newIndex, 0, moved);

    const result = binding.reorderPath(path, next);
    if (result.ok) {
      clearError(moved);
      return;
    }
    const message = describeError(result.error, moved, t`Failed to reorder`);
    applyError(moved, message);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const dupCount = new Map<string, number>();
  for (const [k] of entries) dupCount.set(k, (dupCount.get(k) ?? 0) + 1);

  return (
    <div
      data-testid="object-widget"
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
            data-testid="object-widget-trigger"
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
              {entries.length === 0 ? (
                <Trans>empty</Trans>
              ) : (
                <Plural value={entries.length} one="# key" other="# keys" />
              )}
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-[collapsible-down_150ms_ease-out] data-[state=closed]:animate-[collapsible-up_150ms_ease-in]">
          <div
            data-testid="object-widget-children"
            data-key={keyName}
            className="mt-0.5 ml-2 border-l border-border/60 pl-2"
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={entries.map(([k], i) => nestedRowId(k, i))}
                strategy={verticalListSortingStrategy}
              >
                {entries.map(([childKey, childValue], idx) => {
                  const declared = inferType(childValue);
                  const renameState = renaming?.key === childKey ? renaming : null;
                  const isDuplicate = (dupCount.get(childKey) ?? 0) > 1;
                  const childPath = pathOf(childKey);
                  return (
                    <FrontmatterRow
                      // biome-ignore lint/suspicious/noArrayIndexKey: position-aware key for dup-name rows.
                      key={`${childKey}-${idx}`}
                      sortableId={readOnly ? undefined : nestedRowId(childKey, idx)}
                      keyName={childKey}
                      value={childValue}
                      declared={declared}
                      error={errors[childKey] ?? null}
                      resetCounter={resetCounters[childKey] ?? 0}
                      isDuplicate={isDuplicate}
                      path={childPath}
                      rename={
                        readOnly
                          ? undefined
                          : {
                              state: renameState,
                              onBegin: () => beginChildRename(childKey),
                              onChangeDraft: changeRenameDraft,
                              onCommit: commitRename,
                              onCancel: cancelRename,
                            }
                      }
                      onCommit={(v) => commitChild(childKey, v)}
                      onChangeType={(nextType) => changeChildType(childKey, nextType)}
                      onRemove={readOnly ? undefined : () => removeChild(childKey)}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
            {readOnly ? null : adding ? (
              <AddPropertyRow
                draft={adding}
                onChangeName={changeAddName}
                onChangeType={changeAddType}
                onChangeValue={changeAddValue}
                onCommit={commitAdd}
                onCancel={cancelAdd}
              />
            ) : (
              <div className="mt-1 flex items-center gap-1">
                <span aria-hidden className="h-7 w-4 shrink-0" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="object-widget-add-trigger"
                  data-key={keyName}
                  onClick={beginAdd}
                  aria-label={t`Add property to ${keyName}`}
                  className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium hover:bg-muted/50 hover:text-foreground"
                >
                  <Plus className="size-3.5" />
                  <span>
                    <Trans>Add</Trans>
                  </span>
                </Button>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

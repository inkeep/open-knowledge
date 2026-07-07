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
import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  bindFrontmatterDoc,
  type FrontmatterBinding,
  type FrontmatterPatch,
  type FrontmatterSnapshot,
  type FrontmatterType,
  type FrontmatterValue,
  fieldErrorsFromError,
  frontmatterValuesEqual,
  inferType,
  isFrontmatterValueEmpty,
  readFmKeys,
  readFmRegionWithError,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { FrontmatterBindingProvider } from '@/components/FrontmatterBindingContext';
import {
  type AddDraft,
  AddPropertyRow,
  FrontmatterRow,
  type RenameDraft,
} from '@/components/FrontmatterRow';
import { useProperties } from '@/components/PropertyContext';
import { PropertyDisclosure } from '@/components/PropertyDisclosure';
import { coerceValue, DEFAULT_VALUE_FOR_TYPE } from '@/components/PropertyWidgets';
import { Button } from '@/components/ui/button';
import { usePublishFrontmatterSelection } from '@/hooks/use-selection-context';

interface PropertyPanelProps {
  provider: HocuspocusProvider;
  /**
   * Top-level frontmatter keys to hide from the auto-rendered rows. The skill
   * panel reserves `name` (it is the skill's folder identity — renamed via a
   * git-mv affordance, never a plain frontmatter patch, exactly as a document's
   * filename is not one of its properties). Defaults to none, so the document
   * panel renders every field unchanged.
   */
  reservedKeys?: readonly string[];
}

function readInitialSnapshot(provider: PropertyPanelProps['provider']): FrontmatterSnapshot {
  const ytext = provider.document.getText('source').toString();
  const { map, parseError } = readFmRegionWithError(ytext);
  const keys = readFmKeys(ytext);
  return { map, keys, parseError };
}

export function PropertyPanel({ provider, reservedKeys }: PropertyPanelProps) {
  const { t } = useLingui();
  const reserved = new Set(reservedKeys ?? []);
  // Binding for read + write — over the YAML region of `Y.Text('source')`.
  // The initial snapshot is read synchronously from the provider so SSR + the
  // first client render see the right state without waiting for a useEffect.
  const [binding, setBinding] = useState<FrontmatterBinding | null>(null);
  const [snapshot, setSnapshot] = useState<FrontmatterSnapshot>(() =>
    readInitialSnapshot(provider),
  );

  useEffect(() => {
    const next = bindFrontmatterDoc(provider);
    setBinding(next);
    setSnapshot(next.current());
    const unsub = next.subscribe((s) => {
      setSnapshot(s);
    });
    return () => {
      unsub();
      next.dispose();
      setBinding((prev) => (prev === next ? null : prev));
    };
  }, [provider]);

  const map = snapshot.map;
  const orderedKeys = snapshot.keys;
  const parseError = snapshot.parseError;

  const [collapsed, setCollapsed] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, FrontmatterType>>({});
  const [adding, setAdding] = useState<AddDraft | null>(null);
  const [renaming, setRenaming] = useState<RenameDraft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [resetCounters, setResetCounters] = useState<Record<string, number>>({});
  const docName = provider.configuration.name ?? '';

  // Publish a highlight inside the property panel into the selection-context
  // store (keyed `(docName, 'frontmatter')`) so a property-value selection feeds
  // the Ask AI composer exactly like a body-text selection — no per-row "use as
  // context" button.
  const panelRef = useRef<HTMLDivElement>(null);
  usePublishFrontmatterSelection(panelRef, docName);

  // A doc's property panel shows the doc's OWN frontmatter only. Folder
  // frontmatter is descriptive (about the folder) and does not cascade into
  // child docs, so there are no inherited or declared-field rows here.

  function commitPatch(patch: FrontmatterPatch): PatchResult {
    if (!binding) {
      return { ok: false, error: t`Connecting` };
    }
    const result = binding.patch(patch);
    if (result.ok) return { ok: true };
    if (result.error.code === 'WRITE_ERROR') {
      console.warn('[PropertyPanel] binding write error:', result.error.detail);
      return { ok: false, error: result.error.detail };
    }
    const fieldErrors = fieldErrorsFromError(result.error);
    const firstIssue = result.error.issues[0]?.message ?? t`Invalid patch payload`;
    return {
      ok: false,
      error: firstIssue,
      fieldErrors: Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined,
    };
  }

  function clearError(key: string) {
    setErrors((prev) => {
      if (!Object.hasOwn(prev, key)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function setErrorForKeys(result: PatchResult, keys: readonly string[]) {
    if (result.ok) return;
    const generic = result.error ?? t`Failed to update property`;
    const fieldErrors = result.fieldErrors ?? {};
    setErrors((prev) => {
      const next = { ...prev };
      for (const key of keys) {
        next[key] = fieldErrors[key] ?? generic;
      }
      return next;
    });
    setResetCounters((prev) => {
      const next = { ...prev };
      for (const key of keys) {
        next[key] = (next[key] ?? 0) + 1;
      }
      return next;
    });
  }

  function commitProperty(key: string, value: FrontmatterValue) {
    clearError(key);
    const result = commitPatch({ [key]: value });
    setErrorForKeys(result, [key]);
  }

  function removeProperty(key: string) {
    clearError(key);
    const result = commitPatch({ [key]: null });
    setErrorForKeys(result, [key]);
  }

  function renameProperty(oldKey: string, newKey: string): PatchResult {
    if (!binding) return { ok: false, error: t`Connecting` };
    if (oldKey === newKey) return { ok: true };
    const result = binding.rename(oldKey, newKey);
    if (result.ok) return { ok: true };
    if (result.error.code === 'WRITE_ERROR') {
      return { ok: false, error: result.error.detail };
    }
    const fieldErrors = fieldErrorsFromError(result.error);
    const firstIssue = result.error.issues[0]?.message ?? t`Failed to rename`;
    return {
      ok: false,
      error: firstIssue,
      fieldErrors: Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined,
    };
  }

  // @dnd-kit row identity. Source-position-suffixed so dup-name rows
  // (same `key` string twice) get distinct sortable ids — yaml@2 with
  // `uniqueKeys: false` admits duplicates and the panel surfaces them
  // as distinct rows.
  function rowId(key: string, idx: number): string {
    return `${key} ${idx}`;
  }

  /**
   * Drop handler — translates @dnd-kit's `(activeId, overId)` into the
   * permuted key list and commits via `binding.reorder()`. The binding's
   * commit recomputes the FM region byte range INSIDE its transact
   * (STOP_IF), so a peer body edit between mouseup and commit can't corrupt
   * the FM region.
   */
  function handleDragEnd(event: DragEndEvent): void {
    if (!binding) return;
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) return;

    const ids = orderedKeys.map((k, i) => rowId(k, i));
    const oldIndex = ids.indexOf(activeId);
    const newIndex = ids.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return;

    const next = orderedKeys.slice();
    const [moved] = next.splice(oldIndex, 1);
    if (!moved) return;
    next.splice(newIndex, 0, moved);

    const result = binding.reorder(next);
    if (!result.ok) {
      console.warn('[PropertyPanel] reorder failed:', result.error);
    }
  }

  // Pointer + keyboard sensors. KeyboardSensor's
  // sortableKeyboardCoordinates handles arrow-key navigation between
  // sortable items + announces moves via @dnd-kit's accessibility preset.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function setType(key: string, nextType: FrontmatterType) {
    // Coerce the existing file value to the new type.
    const current = map[key];
    if (current === undefined) return;
    setOverrides((prev) => ({ ...prev, [key]: nextType }));
    const coerced = coerceValue(current, nextType);
    if (!Object.hasOwn(map, key) || !frontmatterValuesEqual(current, coerced)) {
      commitProperty(key, coerced);
    }
  }

  function beginAdd() {
    setAdding({ name: '', type: 'text', value: '', error: null });
    setCollapsed(false);
  }

  // Cross-tree signal from the toolbar's "Add Properties" button.
  const { addPropertySignal, clearAddProperty } = useProperties();
  const addSignal = addPropertySignal.get(docName) ?? 0;
  useEffect(() => {
    if (addSignal > 0) {
      setAdding({ name: '', type: 'text', value: '', error: null });
      setCollapsed(false);
    }
  }, [addSignal]);
  useEffect(() => {
    return () => clearAddProperty(docName);
  }, [docName, clearAddProperty]);

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

  function changeAddValue(value: FrontmatterValue) {
    setAdding((prev) => (prev ? { ...prev, value } : prev));
  }

  function changeAddName(name: string) {
    setAdding((prev) => (prev ? { ...prev, name, error: null } : prev));
  }

  function commitAdd(valueOverride?: FrontmatterValue) {
    if (!adding) return;
    // Enter-in-value-field carries the freshly-typed value (the draft state
    // update from the widget's onCommit lands after this synchronous call).
    const value = valueOverride ?? adding.value;
    const trimmed = adding.name.trim();
    if (!trimmed) {
      setAdding({ ...adding, value, error: t`Name is required` });
      return;
    }
    // Empty value would be dropped server-side by mergePatch; gate here so the
    // user gets an explicit error rather than a silent no-op (the Enter-to-add
    // keyboard paths bypass the Add button's disabled state).
    if (isFrontmatterValueEmpty(value)) {
      setAdding({ ...adding, value, error: t`Value is required` });
      return;
    }
    if (trimmed === 'frontmatter') {
      setAdding({ ...adding, value, error: t`"frontmatter" is a reserved property name` });
      return;
    }
    if (Object.hasOwn(map, trimmed)) {
      setAdding({ ...adding, value, error: t`Property "${trimmed}" already exists` });
      return;
    }
    const result = commitPatch({ [trimmed]: value });
    if (result.ok) {
      setAdding(null);
      return;
    }
    const fieldError = result.fieldErrors?.[trimmed];
    const generic = result.error ?? t`Failed to add property`;
    setAdding({ ...adding, value, error: fieldError ?? generic });
  }

  function cancelAdd() {
    setAdding(null);
  }

  function beginRename(key: string) {
    setRenaming({ key, draft: key, error: null });
  }

  function changeRenameDraft(draft: string) {
    setRenaming((prev) => (prev ? { ...prev, draft, error: null } : prev));
  }

  function cancelRename() {
    setRenaming(null);
  }

  function commitRename() {
    if (!renaming) return;
    const trimmed = renaming.draft.trim();
    if (!trimmed) {
      // Empty/whitespace name during typing is a transient panel state;
      // don't commit, just close the editor.
      setRenaming(null);
      return;
    }
    if (trimmed === renaming.key) {
      setRenaming(null);
      return;
    }
    if (trimmed === 'frontmatter') {
      setRenaming({ ...renaming, error: t`"frontmatter" is a reserved property name` });
      return;
    }
    if (Object.hasOwn(map, trimmed)) {
      setRenaming({ ...renaming, error: t`Property "${trimmed}" already exists` });
      return;
    }
    const result = renameProperty(renaming.key, trimmed);
    if (result.ok) {
      setOverrides((prev) => {
        if (!Object.hasOwn(prev, renaming.key)) return prev;
        const next = { ...prev };
        next[trimmed] = next[renaming.key];
        delete next[renaming.key];
        return next;
      });
      clearError(renaming.key);
      setRenaming(null);
      return;
    }
    const fieldError = result.fieldErrors?.[trimmed] ?? result.fieldErrors?.[renaming.key];
    const message = fieldError ?? result.error ?? t`Failed to rename property`;
    setRenaming({ ...renaming, error: message });
  }

  // Pick render keys from snapshot order. When YAML is malformed, `parseError`
  // is set and `keys` may be empty (the panel renders the last-valid map's
  // keys derived from `Object.keys(map)` — a degraded but non-blocking state).
  const renderKeys = (orderedKeys.length > 0 ? orderedKeys : Object.keys(map)).filter(
    (k) => !reserved.has(k),
  );

  // Duplicate-name detection. When the same name appears twice in the
  // YAML region, mark every affected row with a duplicate-name marker.
  const dupCount = new Map<string, number>();
  for (const k of renderKeys) dupCount.set(k, (dupCount.get(k) ?? 0) + 1);

  if (renderKeys.length === 0 && !adding && !parseError) return null;

  return (
    <FrontmatterBindingProvider binding={binding}>
      <PropertyDisclosure
        ref={panelRef}
        title={<Trans>Properties</Trans>}
        testId="property-panel"
        className="pt-4 pb-4"
        open={!collapsed}
        onOpenChange={(open) => setCollapsed(!open)}
      >
        {parseError ? (
          <div
            role="alert"
            data-testid="property-panel-yaml-error"
            className="mb-1 flex items-start gap-1.5 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive"
          >
            <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
            <div>
              <Trans>
                The properties block at the top of this doc has a formatting error. Switch to source
                mode to fix it.
              </Trans>
              <span className="block text-[10px] opacity-80">{parseError}</span>
            </div>
          </div>
        ) : null}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={renderKeys.map((k, i) => rowId(k, i))}
            strategy={verticalListSortingStrategy}
          >
            {renderKeys.map((key, idx) => {
              const value = map[key];
              if (value === undefined) return null;
              const declared = overrides[key] ?? inferType(value);
              const renameState = renaming?.key === key ? renaming : null;
              const isDuplicate = (dupCount.get(key) ?? 0) > 1;
              // File-owned key. The trash icon deletes the key from the
              // file's own frontmatter.
              // Position-aware sortable id: dup-name rows share the same
              // `key` string, so we suffix with the source-order index so
              // SortableContext can distinguish them. yaml@2 with
              // `uniqueKeys: false` admits duplicates, and the panel
              // surfaces them as distinct rows. The index is load-bearing
              // here precisely because the YAML source order is the
              // rendered order — biome/lint warns about index keys for
              // unstable arrays, but FM rows are deterministic by source
              // position.
              return (
                <FrontmatterRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: position-aware key for dup-name rows.
                  key={`${key}-${idx}`}
                  sortableId={rowId(key, idx)}
                  keyName={key}
                  value={value}
                  declared={declared}
                  error={errors[key] ?? null}
                  resetCounter={resetCounters[key] ?? 0}
                  isDuplicate={isDuplicate}
                  rename={{
                    state: renameState,
                    onBegin: () => beginRename(key),
                    onChangeDraft: changeRenameDraft,
                    onCommit: commitRename,
                    onCancel: cancelRename,
                  }}
                  onCommit={(v) => commitProperty(key, v)}
                  onChangeType={(t) => setType(key, t)}
                  onRemove={() => removeProperty(key)}
                />
              );
            })}
          </SortableContext>
        </DndContext>
        {/*
            Tags discoverability affordance — render an empty, pinned-at-
            end `tags` row when the key is absent from the file YAML
            (`map`). The first commit from this virtual row writes the YAML
            key, at which point the row appears at its natural position in
            `renderKeys` and this branch stops rendering. Existing
            `tags: [...]` / `tags: []` hit the regular row plumbing above;
            the virtual row is purely for "this doc has no tags field yet,
            but you can add one here."
          */}
        {!reserved.has('tags') && !Object.hasOwn(map, 'tags') ? (
          <FrontmatterRow
            key="virtual-tags"
            keyName="tags"
            value={[]}
            declared="list"
            error={errors.tags ?? null}
            resetCounter={resetCounters.tags ?? 0}
            isPlaceholder
            onCommit={(v) => commitProperty('tags', v)}
            // No type-change for the virtual row — the chip widget is
            // the only meaningful editor for `tags`, and
            // `isPlaceholder` hides the type-icon dropdown anyway.
            // The handler is required by the type but never reaches
            // user input here.
            onChangeType={() => {}}
          />
        ) : null}
        {adding ? (
          <AddPropertyRow
            draft={adding}
            onChangeName={changeAddName}
            onChangeType={changeAddType}
            onChangeValue={changeAddValue}
            onCommit={commitAdd}
            onCancel={cancelAdd}
          />
        ) : (
          // Wrapper mirrors FrontmatterRow's flex layout above: an
          // aria-hidden `w-4` spacer occupies the drag-handle column,
          // gap-1 separates it from the Button (which itself starts at
          // the TypeIcon column edge). Result: the Button's hover
          // background starts at 20px (=16+4) — the same x as the
          // TypeIconButton in the rows above — instead of stretching
          // all the way to the row's left edge as `pl-7` would. The
          // `+` icon center still lands at ~35px (20+8+7), within ±2px
          // of the TypeIconButton icon center (34px).
          <div className="mt-1 flex items-center gap-1">
            <span aria-hidden className="h-7 w-4 shrink-0" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="add-property-trigger"
              onClick={beginAdd}
              // Visible label is just "Add"; the aria-label restores the
              // action's object so screen readers don't announce a
              // context-free "Add, button".
              aria-label={t`Add property`}
              className="flex items-center gap-1.5 rounded px-2 py-1 font-medium text-sm hover:bg-muted/50 hover:text-foreground"
            >
              <Plus className="size-3.5" />
              <span>
                <Trans>Add</Trans>
              </span>
            </Button>
          </div>
        )}
      </PropertyDisclosure>
    </FrontmatterBindingProvider>
  );
}

interface PatchResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}

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
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { CommentedDocProvider } from '@/comments/CommentedDocContext';
import { PropertyCommentButton } from '@/comments/PropertyCommentButton';
import { usePropertyAnchorClick } from '@/comments/property-anchor-click';
import type { AddPropertyFieldSuggestion } from '@/components/AddPropertyNameField';
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
import { usePropertiesCollapsed } from '@/components/properties-collapsed-store';
import { Button } from '@/components/ui/button';
import { useDocLintConfig } from '@/editor/lint-config-client';
import { withPreviewTabPromotion } from '@/editor/preview-tab-promotion';
import {
  partitionFrontmatterProblems,
  useFrontmatterDiagnostics,
} from '@/editor/useFrontmatterDiagnostics';
import { usePublishFrontmatterSelection } from '@/hooks/use-selection-context';
import { enumConstraintsForDoc } from '@/lib/frontmatter-enum-constraints';
import { schemaFieldsForDoc } from '@/lib/frontmatter-schema-fields';

interface StagedDraft extends AddDraft {
  id: string;
  focusField: 'name' | 'value';
}

interface PropertyPanelProps {
  provider: HocuspocusProvider;
  reservedKeys?: readonly string[];
  identitySlot?: ReactNode;
}

function readInitialSnapshot(provider: PropertyPanelProps['provider']): FrontmatterSnapshot {
  const ytext = provider.document.getText('source').toString();
  const { map, parseError } = readFmRegionWithError(ytext);
  const keys = readFmKeys(ytext);
  return { map, keys, parseError };
}

export function PropertyPanel({ provider, reservedKeys, identitySlot }: PropertyPanelProps) {
  const { t } = useLingui();
  const reserved = new Set(reservedKeys ?? []);
  const [binding, setBinding] = useState<FrontmatterBinding | null>(null);
  const [snapshot, setSnapshot] = useState<FrontmatterSnapshot>(() =>
    readInitialSnapshot(provider),
  );

  useEffect(() => {
    const next = withPreviewTabPromotion(
      bindFrontmatterDoc(provider),
      provider.configuration.name ?? '',
    );
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

  const [collapsed, setCollapsed] = usePropertiesCollapsed();
  const [overrides, setOverrides] = useState<Record<string, FrontmatterType>>({});
  const [adding, setAdding] = useState<StagedDraft[]>([]);
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const blankDraftSeq = useRef(0);
  const [renaming, setRenaming] = useState<RenameDraft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [resetCounters, setResetCounters] = useState<Record<string, number>>({});
  const docName = provider.configuration.name ?? '';

  const { data: lintConfigData } = useDocLintConfig(docName === '' ? null : docName);
  const enumConstraints = enumConstraintsForDoc(lintConfigData?.effective ?? null, docName);
  const { invalid: invalidProperties, missing: missingProperties } = partitionFrontmatterProblems(
    useFrontmatterDiagnostics(provider, lintConfigData?.effective ?? null),
  );
  const schemaFields = schemaFieldsForDoc(lintConfigData?.effective ?? null, docName);

  const panelRef = useRef<HTMLDivElement>(null);
  usePublishFrontmatterSelection(panelRef, docName);
  usePropertyAnchorClick(panelRef, docName);

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

  function rowId(key: string, idx: number): string {
    return `${key} ${idx}`;
  }

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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function setType(key: string, nextType: FrontmatterType) {
    const current = map[key];
    if (current === undefined) return;
    setOverrides((prev) => ({ ...prev, [key]: nextType }));
    const coerced = coerceValue(current, nextType);
    if (!Object.hasOwn(map, key) || !frontmatterValuesEqual(current, coerced)) {
      commitProperty(key, coerced);
    }
  }

  function defaultValueFor(type: FrontmatterType): FrontmatterValue {
    return type === 'date' ? new Date().toISOString().slice(0, 10) : DEFAULT_VALUE_FOR_TYPE[type];
  }

  function blankDraft(): StagedDraft {
    blankDraftSeq.current += 1;
    return {
      id: `blank-${blankDraftSeq.current}`,
      name: '',
      type: 'text',
      value: '',
      error: null,
      focusField: 'name',
    };
  }

  function stageMissingDrafts(): StagedDraft[] {
    const staged: StagedDraft[] = [];
    for (const diagnostic of missingProperties) {
      const name = diagnostic.frontmatterProperty;
      if (name === undefined || name === '') continue;
      if (Object.hasOwn(map, name)) continue;
      if (reserved.has(name)) continue;
      const id = `staged-${name}`;
      const existing = adding.find((draft) => draft.id === id);
      if (existing) {
        staged.push(existing);
        continue;
      }
      const type = schemaFields.get(name)?.type ?? 'text';
      staged.push({
        id,
        name,
        type,
        value: DEFAULT_VALUE_FOR_TYPE[type],
        error: null,
        focusField: 'value',
      });
    }
    return staged;
  }

  function openDrafts(drafts: StagedDraft[]) {
    setAdding(drafts);
    setFocusRowId(drafts[0]?.id ?? null);
    setCollapsed(false);
  }

  function beginAddBlank() {
    openDrafts([blankDraft()]);
  }

  function beginAddMissing() {
    const staged = stageMissingDrafts();
    openDrafts(staged.length > 0 ? staged : [blankDraft()]);
  }

  const { addPropertySignal, clearAddProperty } = useProperties();
  const addSignal = addPropertySignal.get(docName) ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `beginAddMissing` closes over live render state (the snapshot map, the diagnostics) and is a new function every render — depending on it would re-stage the rows continuously, discarding whatever the user had typed. The counter is the signal; the effect must fire on it alone.
  useEffect(() => {
    if (addSignal > 0) beginAddMissing();
  }, [addSignal]);
  useEffect(() => {
    return () => clearAddProperty(docName);
  }, [docName, clearAddProperty]);

  function updateDraft(id: string, patch: (draft: StagedDraft) => StagedDraft) {
    setAdding((prev) => prev.map((draft) => (draft.id === id ? patch(draft) : draft)));
  }

  function changeAddType(id: string, nextType: FrontmatterType) {
    updateDraft(id, (draft) => ({
      ...draft,
      type: nextType,
      value: defaultValueFor(nextType),
      error: null,
    }));
  }

  function changeAddValue(id: string, value: FrontmatterValue) {
    updateDraft(id, (draft) => ({ ...draft, value }));
  }

  function changeAddName(id: string, name: string) {
    updateDraft(id, (draft) => ({ ...draft, name, error: null }));
  }

  function pickAddField(id: string, suggestion: AddPropertyFieldSuggestion) {
    updateDraft(id, (draft) => ({
      ...draft,
      name: suggestion.name,
      type: suggestion.type,
      value: defaultValueFor(suggestion.type),
      error: null,
    }));
  }

  function commitAdd(id: string, valueOverride?: FrontmatterValue) {
    const draft = adding.find((entry) => entry.id === id);
    if (!draft) return;
    const value = valueOverride ?? draft.value;
    const fail = (error: string) => updateDraft(id, (prev) => ({ ...prev, value, error }));
    const trimmed = draft.name.trim();
    if (!trimmed) {
      fail(t`Name is required`);
      return;
    }
    if (isFrontmatterValueEmpty(value)) {
      fail(t`Value is required`);
      return;
    }
    if (trimmed === 'frontmatter') {
      fail(t`"frontmatter" is a reserved property name`);
      return;
    }
    if (Object.hasOwn(map, trimmed)) {
      fail(t`Property "${trimmed}" already exists`);
      return;
    }
    const result = commitPatch({ [trimmed]: value });
    if (result.ok) {
      setAdding((prev) => prev.filter((entry) => entry.id !== id));
      return;
    }
    fail(result.fieldErrors?.[trimmed] ?? result.error ?? t`Failed to add property`);
  }

  function cancelAdd(id: string) {
    setAdding((prev) => prev.filter((entry) => entry.id !== id));
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

  const renderKeys = (orderedKeys.length > 0 ? orderedKeys : Object.keys(map)).filter(
    (k) => !reserved.has(k),
  );

  const dupCount = new Map<string, number>();
  for (const k of renderKeys) dupCount.set(k, (dupCount.get(k) ?? 0) + 1);

  if (
    renderKeys.length === 0 &&
    adding.length === 0 &&
    !parseError &&
    !identitySlot &&
    invalidProperties.length === 0
  ) {
    return null;
  }

  const offerableFields: AddPropertyFieldSuggestion[] = [...schemaFields]
    .filter(([name]) => !Object.hasOwn(map, name) && !reserved.has(name))
    .map(([name, field]) => ({ name, ...field }));

  function suggestionsFor(rowId: string): AddPropertyFieldSuggestion[] {
    const claimed = new Set(
      adding
        .filter((draft) => draft.id !== rowId)
        .map((draft) => draft.name.trim())
        .filter((name) => name !== ''),
    );
    return claimed.size === 0
      ? offerableFields
      : offerableFields.filter((field) => !claimed.has(field.name));
  }

  const PROP_CONTENT_SHIFT = '[--prop-drag-gutter:1.375rem] -ml-(--prop-drag-gutter)';
  const PROP_GUTTER_COMPENSATE = 'ml-(--prop-drag-gutter)';

  return (
    <FrontmatterBindingProvider binding={binding}>
      {}
      <CommentedDocProvider docName={docName === '' ? null : docName}>
        <PropertyDisclosure
          ref={panelRef}
          title={<Trans>Properties</Trans>}
          count={renderKeys.length}
          problemCount={invalidProperties.length}
          problemMessages={invalidProperties.map((d) => d.message)}
          testId="property-panel"
          className="pt-4"
          contentClassName={PROP_CONTENT_SHIFT}
          open={!collapsed}
          onOpenChange={(open) => setCollapsed(!open)}
        >
          {parseError ? (
            <div
              role="alert"
              data-testid="property-panel-yaml-error"
              className={`mb-1 ${PROP_GUTTER_COMPENSATE} flex items-start gap-1.5 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive`}
            >
              <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
              <div>
                <Trans>
                  The properties block at the top of this doc has a formatting error. Switch to
                  source mode to fix it.
                </Trans>
                <span className="block text-[10px] opacity-80">{parseError}</span>
              </div>
            </div>
          ) : null}
          {}
          {identitySlot}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
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
                return (
                  <FrontmatterRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: position-aware key for dup-name rows.
                    key={`${key}-${idx}`}
                    sortableId={rowId(key, idx)}
                    keyName={key}
                    value={value}
                    declared={declared}
                    enumConstraint={enumConstraints.get(key)}
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
                    actionSlot={<PropertyCommentButton propertyKey={key} />}
                  />
                );
              })}
            </SortableContext>
          </DndContext>
          {}
          {!reserved.has('tags') && !Object.hasOwn(map, 'tags') ? (
            <FrontmatterRow
              key="virtual-tags"
              keyName="tags"
              value={[]}
              declared="list"
              enumConstraint={enumConstraints.get('tags')}
              error={errors.tags ?? null}
              resetCounter={resetCounters.tags ?? 0}
              isPlaceholder
              onCommit={(v) => commitProperty('tags', v)}
              onChangeType={() => {}}
            />
          ) : null}
          {adding.length > 0 ? (
            <div className={PROP_GUTTER_COMPENSATE}>
              {adding.map((draft) => (
                <AddPropertyRow
                  key={draft.id}
                  rowId={draft.id}
                  draft={draft}
                  autoFocus={draft.id === focusRowId ? draft.focusField : 'none'}
                  enumConstraint={enumConstraints.get(draft.name.trim())}
                  fieldSuggestions={suggestionsFor(draft.id)}
                  onChangeName={(name) => changeAddName(draft.id, name)}
                  onChangeType={(type) => changeAddType(draft.id, type)}
                  onChangeValue={(value) => changeAddValue(draft.id, value)}
                  onPickField={(suggestion) => pickAddField(draft.id, suggestion)}
                  onCommit={(valueOverride) => commitAdd(draft.id, valueOverride)}
                  onCancel={() => cancelAdd(draft.id)}
                />
              ))}
            </div>
          ) : (
            <div className="mt-1 flex items-center gap-1">
              <span aria-hidden className="h-7 w-4 shrink-0" />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="add-property-trigger"
                onClick={beginAddBlank}
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
      </CommentedDocProvider>
    </FrontmatterBindingProvider>
  );
}

interface PatchResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}

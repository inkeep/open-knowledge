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

/**
 * An add-row in flight. The id keys the row across renders so a sibling
 * committing or being dismissed doesn't renumber the rest — names can't serve,
 * since staged rows start out editable and a blank row has none.
 */
interface StagedDraft extends AddDraft {
  id: string;
  /**
   * Which control this row wants on mount, decided once when the row is staged.
   * Deriving it from the live draft instead would re-decide as the user types:
   * a blank row whose name goes from `''` to `'a'` would flip from wanting the
   * name to wanting the value, and yank the caret out of the field mid-word.
   */
  focusField: 'name' | 'value';
}

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
  /**
   * Identity rows rendered at the TOP of the Properties disclosure, above the
   * auto-rendered frontmatter rows. The skill panel passes its `name` row here
   * so `name` reads as the first property (with a fixed, non-editable key) while
   * still committing a rename rather than a plain patch. Keep the corresponding
   * keys in `reservedKeys` so they aren't double-rendered as frontmatter rows.
   */
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
  // Binding for read + write — over the YAML region of `Y.Text('source')`.
  // The initial snapshot is read synchronously from the provider so SSR + the
  // first client render see the right state without waiting for a useEffect.
  const [binding, setBinding] = useState<FrontmatterBinding | null>(null);
  const [snapshot, setSnapshot] = useState<FrontmatterSnapshot>(() =>
    readInitialSnapshot(provider),
  );

  useEffect(() => {
    // Wrapped so every mutating route — this panel's own patch/rename/reorder
    // AND the path-addressed edits nested widgets issue through
    // `FrontmatterBindingContext` — promotes the doc's preview tab.
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

  // Collapsed state is a persisted, user-global preference shared LIVE across all
  // mounted panels (see properties-collapsed-store): collapsing on one file
  // collapses the section everywhere, immediately, and survives reload. The live
  // resize of a hidden, scrolled doc is kept scroll-safe by
  // ScrollPreservingContainer's body-top anchor restore. The `setCollapsed(false)`
  // force-expands below (add-property intent) also persist "open"; that's intended.
  const [collapsed, setCollapsed] = usePropertiesCollapsed();
  const [overrides, setOverrides] = useState<Record<string, FrontmatterType>>({});
  // A list, not one draft: the toolbar's Add-properties button on a doc missing
  // several schema-required properties stages a pre-named row for each. Ids are
  // stable per staged row so React keys and the value-focus target survive a
  // sibling row committing or being dismissed.
  const [adding, setAdding] = useState<StagedDraft[]>([]);
  // Which staged row takes focus on mount — the first of a batch. Read only at
  // mount (an `autoFocus` attribute and a once-per-row effect), so it can stay
  // set: a re-render never re-steals the caret from whichever field the user
  // has since moved to.
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const blankDraftSeq = useRef(0);
  const [renaming, setRenaming] = useState<RenameDraft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [resetCounters, setResetCounters] = useState<Record<string, number>>({});
  const docName = provider.configuration.name ?? '';

  // Schema-driven select vocabularies: enum-constrained fields render as
  // selects instead of free text (same schemas + same appliesTo matching as
  // the linter, via the server-resolved effective config). Resolution failure
  // or a disabled plugin degrades to today's free-text panel.
  const { data: lintConfigData } = useDocLintConfig(docName === '' ? null : docName);
  const enumConstraints = enumConstraintsForDoc(lintConfigData?.effective ?? null, docName);
  // Properties that exist but violate the schema badge this panel's own count.
  // The missing ones travel to the toolbar's Add-properties button instead —
  // they have no row here to point at, and adding is their fix, not correcting.
  // This panel still reads them: acting on that button lands here, as a staged
  // row per absent property.
  const { invalid: invalidProperties, missing: missingProperties } = partitionFrontmatterProblems(
    useFrontmatterDiagnostics(provider, lintConfigData?.effective ?? null),
  );
  // What the governing schemas DECLARE, for the name field's type-ahead and for
  // a staged row's widget type. Same resolved config and same schema selection
  // as the enum vocabularies above.
  const schemaFields = schemaFieldsForDoc(lintConfigData?.effective ?? null, docName);

  // Publish a highlight inside the property panel into the selection-context
  // store (keyed `(docName, 'frontmatter')`) so a property-value selection feeds
  // the Ask AI composer exactly like a body-text selection — no per-row "use as
  // context" button.
  const panelRef = useRef<HTMLDivElement>(null);
  usePublishFrontmatterSelection(panelRef, docName);
  // Clicking a commented value opens its thread, the way clicking a commented
  // passage does in the body. Panel-scoped for the same reason the selection
  // hook is: hidden entries in the editor pool keep their panels mounted.
  usePropertyAnchorClick(panelRef, docName);

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

  function defaultValueFor(type: FrontmatterType): FrontmatterValue {
    return type === 'date' ? new Date().toISOString().slice(0, 10) : DEFAULT_VALUE_FOR_TYPE[type];
  }

  /** An unnamed row — nothing to fill in yet, so it opens in its name field. */
  function blankDraft(): StagedDraft {
    // A fresh id each time, so re-requesting an add remounts the row and its
    // `autoFocus` fires again rather than leaving a stale row focused.
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

  /**
   * One pre-named row per schema-required property the doc lacks — the schema
   * already names them, so making the user retype them is the whole complaint.
   * Empty when nothing is missing or no schema governs the doc.
   *
   * Nothing is written here. A staged row is a draft like any other and only
   * reaches the file once the user supplies a value and commits it, so an
   * empty placeholder can never land in the doc and quietly satisfy the
   * `required` check that produced the row.
   *
   * One row per property comes from `partitionFrontmatterProblems`, which is
   * also what the toolbar counts — a second dedupe here would let the two
   * drift.
   */
  function stageMissingDrafts(): StagedDraft[] {
    const staged: StagedDraft[] = [];
    for (const diagnostic of missingProperties) {
      const name = diagnostic.frontmatterProperty;
      if (name === undefined || name === '') continue;
      // The doc may have gained the property since the count was rendered.
      if (Object.hasOwn(map, name)) continue;
      // A reserved key is not this panel's to add — a skill's `name` is its
      // folder identity, renamed by moving the folder, not patched.
      if (reserved.has(name)) continue;
      const id = `staged-${name}`;
      // Re-requesting an add while a row for this property is already open
      // keeps that row — rebuilding it would throw away a value the user had
      // started typing, with nothing on screen to explain where it went.
      const existing = adding.find((draft) => draft.id === id);
      if (existing) {
        staged.push(existing);
        continue;
      }
      const type = schemaFields.get(name)?.type ?? 'text';
      // Pre-named, so the value is the only thing left to supply. Seeded with
      // the type's BASE default, not `defaultValueFor` — a staged row is
      // auto-opened, not chosen, so `defaultValueFor`'s convenience seed for a
      // date (today) would let one Add click write a date the user never
      // picked and clear the required warning that produced the row. The base
      // default is empty for text/date/list, so the commit gate stays shut
      // until they fill it in. `number`/`boolean` have no empty form — 0 and
      // an unchecked box are conventional and visibly the value on offer.
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

  /** Open the add form on `drafts`, expanding the section if it was collapsed. */
  function openDrafts(drafts: StagedDraft[]) {
    setAdding(drafts);
    setFocusRowId(drafts[0]?.id ?? null);
    setCollapsed(false);
  }

  /**
   * The panel's own inline Add. Singular however many required properties the
   * doc lacks — its object is one property (the label says so), and a user
   * reaching for it wants a row to name, not the schema's backlog. Staging that
   * backlog is the toolbar button's affordance, below.
   */
  function beginAddBlank() {
    openDrafts([blankDraft()]);
  }

  /** The toolbar's Add-properties button — the batch affordance. */
  function beginAddMissing() {
    const staged = stageMissingDrafts();
    openDrafts(staged.length > 0 ? staged : [blankDraft()]);
  }

  // Cross-tree signal from the toolbar's "Add Properties" button.
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
    // Name and type in one update — the schema states the type, so picking a
    // field is the whole answer, not a name the user then types a type for.
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
    // Enter-in-value-field carries the freshly-typed value (the draft state
    // update from the widget's onCommit lands after this synchronous call).
    const value = valueOverride ?? draft.value;
    const fail = (error: string) => updateDraft(id, (prev) => ({ ...prev, value, error }));
    const trimmed = draft.name.trim();
    if (!trimmed) {
      fail(t`Name is required`);
      return;
    }
    // Empty value would be dropped server-side by mergePatch; gate here so the
    // user gets an explicit error rather than a silent no-op (the Enter-to-add
    // keyboard paths bypass the Add button's disabled state).
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
      // Only this row closes — its siblings are still unfilled properties the
      // doc is missing.
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

  // A schema constraint on the frontmatter block as a whole (`minProperties`,
  // a root `anyOf`, `not`) fires against an empty object, so it has no property
  // row to attach to — and unmounting here would leave it with no editor
  // surface at all, since the body no longer marks frontmatter violations.
  // Keep the disclosure alive for its badge whenever one is outstanding.
  if (
    renderKeys.length === 0 &&
    adding.length === 0 &&
    !parseError &&
    !identitySlot &&
    invalidProperties.length === 0
  ) {
    return null;
  }

  // Fields the schemas declare that this doc does not already have — the
  // type-ahead vocabulary for an add-row's name field.
  const offerableFields: AddPropertyFieldSuggestion[] = [...schemaFields]
    .filter(([name]) => !Object.hasOwn(map, name) && !reserved.has(name))
    .map(([name, field]) => ({ name, ...field }));

  /**
   * The same list minus what a SIBLING row is already staged to add, so a batch
   * can't point two rows at one property. The row's own name stays offered —
   * excluding it would empty the list the moment a suggestion was picked.
   */
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

  // Flush-left alignment. Sortable rows carry a drag-handle gutter (FrontmatterRow:
  // a `w-4` handle + `gap-1` = 1.25rem) that pushes the type-icon column right of
  // the document content edge. We pull the whole collapsible content left via
  // `--prop-drag-gutter` so the type icons sit flush under the disclosure chevron;
  // the in-flow drag handle overhangs into the page margin — it stays visible
  // because the shift moves the whole `overflow-hidden` box (an inner child would
  // be clipped). The value is tuned slightly ABOVE the raw 1.25rem gutter so the
  // icons land under the chevron GLYPH, which itself sits `px-1` in from the panel
  // edge — hence 1.375rem, not the bare gutter width. Framed children with no
  // gutter (the YAML-error banner, the add-property form) cancel the pull with
  // `PROP_GUTTER_COMPENSATE`.
  const PROP_CONTENT_SHIFT = '[--prop-drag-gutter:1.375rem] -ml-(--prop-drag-gutter)';
  const PROP_GUTTER_COMPENSATE = 'ml-(--prop-drag-gutter)';

  return (
    <FrontmatterBindingProvider binding={binding}>
      {/* Sibling to the binding: the recursive rows below host comment buttons,
          and every one of them needs to know which document it belongs to.
          Empty name means there is no document (an unattached provider), which
          the buttons read as "render nothing". */}
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
            // No drag-handle gutter — cancel the content shift so the banner sits
            // flush instead of hanging into the page margin (see PROP_CONTENT_SHIFT).
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
          {/* Identity rows (e.g. a skill's `name`) render first — they are the
              doc's fixed-key properties, above the free-form frontmatter rows. */}
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
                    // Top-level row: the key IS the whole address. Nested rows
                    // pass their own path (see ObjectWidget). The button itself
                    // decides whether a document is behind it.
                    actionSlot={<PropertyCommentButton propertyKey={key} />}
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
              enumConstraint={enumConstraints.get('tags')}
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
          {adding.length > 0 ? (
            // No drag-handle gutter — cancel the content shift so the add form
            // sits flush with the rows (see PROP_CONTENT_SHIFT).
            <div className={PROP_GUTTER_COMPENSATE}>
              {adding.map((draft) => (
                <AddPropertyRow
                  key={draft.id}
                  rowId={draft.id}
                  draft={draft}
                  // Only the row the batch was opened on takes focus —
                  // `autoFocus` is last-one-wins, so every row claiming it
                  // would land the caret on the bottom one. The target is the
                  // row's own frozen `focusField`, never re-derived from the
                  // live draft.
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
                onClick={beginAddBlank}
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
      </CommentedDocProvider>
    </FrontmatterBindingProvider>
  );
}

interface PatchResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}

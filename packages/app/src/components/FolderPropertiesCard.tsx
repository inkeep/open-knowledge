import {
  type FrontmatterType,
  type FrontmatterValue,
  inferType,
  isFrontmatterValueEmpty,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight, FolderCog, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  type AddDraft,
  AddPropertyRow,
  FrontmatterRow,
  type RenameDraft,
} from '@/components/FrontmatterRow';
import {
  coerceValue,
  DEFAULT_VALUE_FOR_TYPE,
  resolveWidgetType,
} from '@/components/PropertyWidgets';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import type { AsyncState, FolderConfigSnapshot } from '@/hooks/use-folder-config';
import { saveFolderConfig } from '@/lib/folder-config-api';
import { frontmatterYamlPath } from '@/lib/folder-config-paths';

interface Props {
  folderPath: string;
  state: AsyncState<FolderConfigSnapshot>;
  /** Called after a successful save so the parent can re-fetch. */
  onChange: () => void;
}

/**
 * Folder frontmatter editor — the folder's OWN `<folder>/.ok/frontmatter.yml`.
 * Open-shape, exactly like a doc's frontmatter: any key the user wants.
 *
 * Self-only: this metadata describes the folder and does NOT cascade into
 * child docs. Per-doc starting values belong in a template, not here.
 *
 * Renders one FrontmatterRow per key in the folder's own frontmatter, reusing
 * the same widgets file frontmatter uses (PropertyWidgets, FrontmatterRow,
 * AddPropertyRow) so editing feels identical to editing per-doc frontmatter.
 */
export function FolderPropertiesCard({ folderPath, state, onChange }: Props) {
  const { t } = useLingui();
  const [collapsed, setCollapsed] = useState(false);
  const [adding, setAdding] = useState<AddDraft | null>(null);
  const [rename, setRename] = useState<RenameDraft | null>(null);

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <section className="rounded-lg border bg-card p-4 space-y-3">
        <CardHeader />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
      </section>
    );
  }

  if (state.status === 'error') {
    const { message } = state;
    return (
      <section
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        role="alert"
      >
        <Trans>Failed to load folder properties: {message}</Trans>
      </section>
    );
  }

  // The folder's own frontmatter (self-only — no cascade).
  const own = state.data.frontmatterLocal ?? {};
  const filePath = frontmatterYamlPath(state.data.folder.path);
  const orderedKeys = Object.keys(own);

  /**
   * Send a single-key patch to the server. Re-renders happen via the
   * parent's `onChange()` triggering a re-fetch. Empty-value semantics
   * (null / '' / []) clear the key on the server side.
   */
  async function commitKey(key: string, next: FrontmatterValue) {
    const patch: Record<string, unknown> = { [key]: next };
    const result = await saveFolderConfig(folderPath, patch);
    if (!result.ok) {
      const { error } = result;
      toast.error(t`Save failed: ${error}`);
      return;
    }
    onChange();
  }

  async function removeKey(key: string) {
    const result = await saveFolderConfig(folderPath, { [key]: null });
    if (!result.ok) {
      const { error } = result;
      toast.error(t`Remove failed: ${error}`);
      return;
    }
    onChange();
  }

  function setType(key: string, nextType: FrontmatterType) {
    const current = own[key];
    const coerced = coerceValue(current as FrontmatterValue, nextType);
    void commitKey(key, coerced);
  }

  function beginAdd() {
    setAdding({ name: '', type: 'text', value: '', error: null });
    setCollapsed(false);
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

  function changeAddValue(value: FrontmatterValue) {
    setAdding((prev) => (prev ? { ...prev, value } : prev));
  }

  function changeAddName(name: string) {
    setAdding((prev) => (prev ? { ...prev, name, error: null } : prev));
  }

  async function commitAdd(valueOverride?: FrontmatterValue) {
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
    // user gets an explicit error rather than a silent no-op.
    if (isFrontmatterValueEmpty(value)) {
      setAdding({ ...adding, value, error: t`Value is required` });
      return;
    }
    if (Object.hasOwn(own, trimmed)) {
      setAdding({ ...adding, value, error: t`"${trimmed}" already exists here` });
      return;
    }
    const result = await saveFolderConfig(folderPath, { [trimmed]: value });
    if (!result.ok) {
      setAdding({ ...adding, value, error: result.error });
      return;
    }
    setAdding(null);
    onChange();
  }

  function beginRename(key: string) {
    setRename({ key, draft: key, error: null });
  }

  function changeRenameDraft(next: string) {
    setRename((prev) => (prev ? { ...prev, draft: next, error: null } : prev));
  }

  async function commitRename() {
    if (!rename) return;
    const trimmed = rename.draft.trim();
    if (!trimmed) {
      setRename({ ...rename, error: t`Name is required` });
      return;
    }
    if (trimmed === rename.key) {
      setRename(null);
      return;
    }
    if (Object.hasOwn(own, trimmed)) {
      setRename({ ...rename, error: t`"${trimmed}" already exists here` });
      return;
    }
    // Two-step: write the new key with the old value, clear the old key.
    const value = own[rename.key];
    const result = await saveFolderConfig(folderPath, {
      [rename.key]: null,
      [trimmed]: value,
    });
    if (!result.ok) {
      setRename({ ...rename, error: result.error });
      return;
    }
    setRename(null);
    onChange();
  }

  function cancelRename() {
    setRename(null);
  }

  return (
    <section className="rounded-lg border bg-card">
      <Collapsible open={!collapsed} onOpenChange={(open) => setCollapsed(!open)}>
        <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2.5 data-[state=open]:border-b border-border">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase font-mono tracking-wider text-muted-foreground">
            <ChevronRight
              className={`size-3 transition-transform ${collapsed ? '' : 'rotate-90'}`}
              aria-hidden
            />
            <span>
              <Trans>Folder properties</Trans>
            </span>
          </span>
          {/* Stop click bubbling so single / triple click on the path
                doesn't toggle the collapsible. Drag-to-select never fires
                click on its own. <code> isn't focusable, so it can't receive
                keyboard events — biome's useKeyWithClickEvents pairs onClick
                with a keyboard handler by default; here a keyboard handler
                would be dead code since the wrapping <button> handles all
                keyboard activation (Enter/Space → toggle). */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: <code> is non-focusable; keyboard activation lives on the wrapping <button>. */}
          <code
            className="text-xs text-muted-foreground font-mono cursor-text select-text"
            onClick={(e) => e.stopPropagation()}
          >
            {filePath}
          </code>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-2 py-2">
            <p className="px-1 pb-2 text-sm text-muted-foreground">
              <Trans>A title, description, tags — anything that describes this folder.</Trans>
            </p>
            {orderedKeys.length === 0 && !adding ? (
              <p className="px-1 py-1 text-sm text-muted-foreground">
                <Trans>Nothing set yet.</Trans>
              </p>
            ) : (
              orderedKeys.map((key) => {
                const value = own[key] as FrontmatterValue;
                const declared = resolveWidgetType(value, inferType(value));
                return (
                  <FrontmatterRow
                    key={key}
                    keyName={key}
                    value={value}
                    declared={declared}
                    rename={{
                      state: rename?.key === key ? rename : null,
                      onBegin: () => beginRename(key),
                      onChangeDraft: changeRenameDraft,
                      onCommit: commitRename,
                      onCancel: cancelRename,
                    }}
                    badge={null}
                    onCommit={(next) => void commitKey(key, next)}
                    onChangeType={(type) => setType(key, type)}
                    onRemove={() => void removeKey(key)}
                  />
                );
              })
            )}
            {adding ? (
              <AddPropertyRow
                draft={adding}
                onChangeName={changeAddName}
                onChangeType={changeAddType}
                onChangeValue={changeAddValue}
                onCommit={(v) => void commitAdd(v)}
                onCancel={() => setAdding(null)}
              />
            ) : (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="add-property-trigger"
                  onClick={() => beginAdd()}
                  className="flex items-center gap-1.5 rounded px-2 py-1 font-medium text-sm hover:bg-muted/50 hover:text-foreground"
                >
                  <Plus className="size-3.5" />
                  <span>
                    <Trans>Add a property</Trans>
                  </span>
                </Button>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function CardHeader() {
  return (
    <div className="flex items-center gap-2">
      <FolderCog className="size-4 text-muted-foreground" aria-hidden />
      <h2 className="text-xs font-semibold uppercase font-mono tracking-wider text-muted-foreground">
        <Trans>Folder properties</Trans>
      </h2>
    </div>
  );
}

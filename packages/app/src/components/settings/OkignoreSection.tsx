// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

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
import {
  CONFIG_DOC_NAME_OKIGNORE,
  type ConfigValidationError,
  humanFormat,
  isKnownConfigError,
  type OkignoreBinding,
} from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle, Check, GripVertical, X } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { usePageList } from '@/components/PageListContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { subscribeToConfigIgnoreNestedError } from '@/lib/config-ignore-nested-error-events';
import { subscribeToConfigValidationRejected } from '@/lib/config-validation-events';
import { cn } from '@/lib/utils';
import {
  appendPattern,
  editPatternAt,
  findPatternIndex,
  listPatterns,
  type PatternLine,
  parseOkignoreDoc,
  removePatternAt,
  reorderPatterns,
  serializeOkignoreDoc,
} from './okignore-doc';
import { countMatches } from './okignore-preview';
import { checkHeuristicWarnings, type OkignoreWarning } from './okignore-warnings';
import { SettingsSectionHeader } from './SettingsSectionHeader';

interface OkignoreSectionProps {
  binding: OkignoreBinding | null;
  synced: boolean;
}

const PRIMER_HREF = 'https://openknowledge.ai/docs/features/ignore-patterns';
const SAVED_FLASH_MS = 1200;
const HEURISTIC_DEBOUNCE_MS = 150;
const PREVIEW_DEBOUNCE_MS = 150;
const REJECTION_BANNER_MS = 5000;
const REJECTION_FLASH_MS = 600;
const RAW_TEXT_COMMIT_MS = 400;
const SHOW_ADVANCED_LS_KEY = 'okignore-show-advanced';

export function OkignoreSection({ binding, synced }: OkignoreSectionProps) {
  if (binding === null || !synced) {
    return <OkignoreSectionSkeleton />;
  }
  return <OkignoreSectionBody binding={binding} />;
}

function OkignoreSectionSkeleton() {
  return (
    <section
      aria-labelledby="settings-okignore-title"
      className="space-y-3"
      data-testid="settings-okignore-skeleton"
    >
      <SettingsSectionHeader
        titleId="settings-okignore-title"
        title={<Trans>Ignore patterns</Trans>}
        scope="project"
      />
      <Skeleton className="h-4 w-72" />
      <Skeleton className="h-20 w-full" />
    </section>
  );
}

interface SavedFlash {
  key: string;
  ts: number;
}

interface RejectionState {
  message: string;
  lineNumber?: number;
  ts: number;
}

function OkignoreSectionBody({ binding }: { binding: OkignoreBinding }) {
  const { t } = useLingui();
  const [text, setText] = useState(() => binding.current());

  useEffect(() => {
    return binding.subscribe((next) => {
      setText(next);
    });
  }, [binding]);

  const { pages, pageMeta, assetPaths } = usePageList();
  const filePaths = derivePreviewPaths(pages, pageMeta, assetPaths);

  const doc = parseOkignoreDoc(text);
  const patterns = listPatterns(doc);
  const isEmpty = patterns.length === 0;

  const [savedFlash, setSavedFlash] = useState<SavedFlash | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );
  const triggerFlash = (key: string) => {
    setSavedFlash({ key, ts: Date.now() });
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setSavedFlash(null), SAVED_FLASH_MS);
  };

  const [rejection, setRejection] = useState<RejectionState | null>(null);
  const rejectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (rejectionTimerRef.current) clearTimeout(rejectionTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    return subscribeToConfigValidationRejected((event) => {
      if (event.docName !== CONFIG_DOC_NAME_OKIGNORE) return;
      binding.notifyRejection(event.error);
    });
  }, [binding]);

  useEffect(() => {
    return binding.subscribeRejection(({ error }) => {
      const detail = pickOkignoreDetail(error);
      const message = detail?.detail ?? humanFormat(error);
      setRejection({ message, lineNumber: detail?.lineNumber, ts: Date.now() });
      if (rejectionTimerRef.current) clearTimeout(rejectionTimerRef.current);
      rejectionTimerRef.current = setTimeout(() => setRejection(null), REJECTION_BANNER_MS);
    });
  }, [binding]);

  useEffect(() => {
    return subscribeToConfigIgnoreNestedError((event) => {
      const { path } = event;
      toast.error(t`Nested .okignore error in ${path}`, {
        description: event.error,
        id: `okignore-nested-error:${event.path}`,
        duration: 8000,
      });
    });
  }, [t]);

  const commit = (newText: string) => {
    binding.patch(newText);
  };

  const handleEdit = (patternIndex: number, newPatternText: string) => {
    const trimmed = newPatternText.trim();
    const current = patterns[patternIndex];
    if (!current) return;
    if (trimmed === current.text) return;
    if (trimmed.length === 0) {
      commit(serializeOkignoreDoc(removePatternAt(doc, patternIndex)));
      return;
    }
    commit(serializeOkignoreDoc(editPatternAt(doc, patternIndex, trimmed)));
    triggerFlash(rowFlashKey(trimmed, patternIndex));
  };

  const handleRemove = (patternIndex: number) => {
    commit(serializeOkignoreDoc(removePatternAt(doc, patternIndex)));
  };

  const handleAdd = (newPatternText: string) => {
    const trimmed = newPatternText.trim();
    if (trimmed.length === 0) return;
    const existingIndex = findPatternIndex(doc, trimmed);
    if (existingIndex >= 0) {
      triggerFlash(rowFlashKey(trimmed, existingIndex));
      return;
    }
    commit(serializeOkignoreDoc(appendPattern(doc, trimmed)));
    triggerFlash(rowFlashKey(trimmed, patterns.length));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) return;
    const fromIndex = sortIdToIndex(activeId);
    const toIndex = sortIdToIndex(overId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    commit(serializeOkignoreDoc(reorderPatterns(doc, fromIndex, toIndex)));
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const rejectionFlashKey = rejection !== null ? `rejection-${rejection.ts}` : null;

  const [showAdvanced, setShowAdvanced] = useShowAdvanced();

  return (
    <section
      aria-labelledby="settings-okignore-title"
      className="space-y-3"
      data-testid="settings-okignore-section"
    >
      <SettingsSectionHeader
        titleId="settings-okignore-title"
        title={<Trans>Ignore patterns</Trans>}
        scope="project"
      >
        <Trans>
          Hide files and folders from your knowledge base. Hidden items don’t appear in the file
          tree, search, or AI tools.{' '}
          <a
            href={PRIMER_HREF}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline-offset-2 hover:underline"
            data-testid="settings-okignore-primer"
          >
            Learn more about patterns
          </a>
          .
        </Trans>
      </SettingsSectionHeader>
      {rejection !== null ? <RejectionBanner rejection={rejection} /> : null}
      {showAdvanced ? (
        <OkignoreAdvancedEditor binding={binding} text={text} />
      ) : isEmpty ? (
        <OkignoreEmptyState
          onAdd={handleAdd}
          rejectionFlashKey={rejectionFlashKey}
          filePaths={filePaths}
        />
      ) : (
        <OkignorePatternList
          patterns={patterns}
          sensors={sensors}
          onDragEnd={handleDragEnd}
          onEdit={handleEdit}
          onRemove={handleRemove}
          onAdd={handleAdd}
          savedFlash={savedFlash}
          rejectionFlashKey={rejectionFlashKey}
          filePaths={filePaths}
        />
      )}
      <div className="flex justify-end">
        <ShowAdvancedToggle
          enabled={showAdvanced}
          onToggle={() => setShowAdvanced(!showAdvanced)}
        />
      </div>
    </section>
  );
}

function OkignoreAdvancedEditor({ binding, text }: { binding: OkignoreBinding; text: string }) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(text);
  const lastSyncedRef = useRef(text);
  const focusedRef = useRef(false);
  const draftRef = useRef(text);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (focusedRef.current) return;
    if (text === lastSyncedRef.current) return;
    setDraft(text);
    draftRef.current = text;
    lastSyncedRef.current = text;
  }, [text]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    return () => {
      if (commitTimerRef.current) {
        clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
        if (draftRef.current !== lastSyncedRef.current) {
          binding.patch(draftRef.current);
          lastSyncedRef.current = draftRef.current;
        }
      }
    };
  }, [binding]);

  const scheduleCommit = (next: string) => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      if (next === lastSyncedRef.current) return;
      lastSyncedRef.current = next;
      binding.patch(next);
    }, RAW_TEXT_COMMIT_MS);
  };

  const flushCommit = () => {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    if (draftRef.current === lastSyncedRef.current) return;
    lastSyncedRef.current = draftRef.current;
    binding.patch(draftRef.current);
  };

  return (
    <textarea
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        scheduleCommit(e.target.value);
      }}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        flushCommit();
      }}
      spellCheck={false}
      rows={Math.max(6, Math.min(20, draft.split('\n').length + 1))}
      aria-label={t`Ignore patterns (raw text)`}
      placeholder={t`# One pattern per line.\n# Examples:\n#   drafts/\n#   *.draft.md\n#   !keep.md`}
      className="min-h-32 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      data-testid="settings-okignore-advanced-textarea"
    />
  );
}

function ShowAdvancedToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onToggle}
      aria-pressed={enabled}
      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
      data-testid="settings-okignore-show-advanced-toggle"
    >
      {enabled ? <Trans>Hide advanced</Trans> : <Trans>Show advanced</Trans>}
    </Button>
  );
}

function RejectionBanner({ rejection }: { rejection: RejectionState }) {
  const { t } = useLingui();
  const { lineNumber, message } = rejection;
  const bannerText =
    lineNumber !== undefined
      ? t`Pattern syntax error (line ${lineNumber}): ${message}`
      : t`Pattern syntax error: ${message}`;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="settings-okignore-rejection-banner"
      className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive animate-in fade-in"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{bannerText}</span>
    </div>
  );
}

function OkignoreEmptyState({
  onAdd,
  rejectionFlashKey,
  filePaths,
}: {
  onAdd: (text: string) => void;
  rejectionFlashKey: string | null;
  filePaths: ReadonlyArray<string>;
}) {
  const { t } = useLingui();
  return (
    <div
      className="space-y-3 rounded-md border border-dashed p-4"
      data-testid="settings-okignore-empty"
    >
      <p className="text-sm text-muted-foreground">
        <Trans>No patterns yet. Type a folder or file name below to start hiding files.</Trans>
      </p>
      <AddPatternRow
        onAdd={onAdd}
        placeholder={t`e.g. drafts/ or *.draft.md`}
        rejectionFlashKey={rejectionFlashKey}
        filePaths={filePaths}
      />
    </div>
  );
}

function OkignorePatternList({
  patterns,
  sensors,
  onDragEnd,
  onEdit,
  onRemove,
  onAdd,
  savedFlash,
  rejectionFlashKey,
  filePaths,
}: {
  patterns: PatternLine[];
  sensors: ReturnType<typeof useSensors>;
  onDragEnd: (e: DragEndEvent) => void;
  onEdit: (patternIndex: number, text: string) => void;
  onRemove: (patternIndex: number) => void;
  onAdd: (text: string) => void;
  savedFlash: SavedFlash | null;
  rejectionFlashKey: string | null;
  filePaths: ReadonlyArray<string>;
}) {
  const { t } = useLingui();
  const sortableIds = patterns.map((_, i) => indexToSortId(i));
  return (
    <div className="space-y-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <ul
            aria-label={t`Ignore patterns`}
            className="divide-y rounded-md border"
            data-testid="settings-okignore-list"
          >
            {patterns.map((pattern, idx) => {
              const flashKey = rowFlashKey(pattern.text, idx);
              const flashActive = savedFlash !== null && savedFlash.key === flashKey;
              return (
                <SortablePatternRow
                  key={indexToSortId(idx)}
                  sortableId={indexToSortId(idx)}
                  patternIndex={idx}
                  pattern={pattern}
                  onEdit={onEdit}
                  onRemove={onRemove}
                  flashActive={flashActive}
                  filePaths={filePaths}
                />
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>
      <AddPatternRow
        onAdd={onAdd}
        placeholder={t`Add another pattern`}
        rejectionFlashKey={rejectionFlashKey}
        filePaths={filePaths}
      />
    </div>
  );
}

function SortablePatternRow({
  sortableId,
  patternIndex,
  pattern,
  onEdit,
  onRemove,
  flashActive,
  filePaths,
}: {
  sortableId: string;
  patternIndex: number;
  pattern: PatternLine;
  onEdit: (patternIndex: number, text: string) => void;
  onRemove: (patternIndex: number) => void;
  flashActive: boolean;
  filePaths: ReadonlyArray<string>;
}) {
  const { t } = useLingui();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
  });
  const patternText = pattern.text;
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 1 : undefined,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex flex-col gap-0.5 px-2 py-1.5"
      data-testid="settings-okignore-row"
      data-pattern-index={patternIndex}
    >
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="settings-okignore-drag-handle"
          aria-label={t`Drag ${patternText} to reorder`}
          {...attributes}
          {...listeners}
          className="h-7 w-4 shrink-0 cursor-grab touch-none px-0 text-muted-foreground/40 hover:text-foreground focus-visible:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </Button>
        <PatternRowInput
          patternIndex={patternIndex}
          initialText={pattern.text}
          onCommit={(text) => onEdit(patternIndex, text)}
          filePaths={filePaths}
        />
        <SavedIndicator visible={flashActive} />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="settings-okignore-remove"
          aria-label={t`Remove ${patternText}`}
          onClick={() => onRemove(patternIndex)}
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

function PatternRowInput({
  patternIndex,
  initialText,
  onCommit,
  filePaths,
}: {
  patternIndex: number;
  initialText: string;
  onCommit: (text: string) => void;
  filePaths: ReadonlyArray<string>;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(initialText);
  const lastSyncedRef = useRef(initialText);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (focusedRef.current) return;
    if (initialText === lastSyncedRef.current) return;
    setDraft(initialText);
    lastSyncedRef.current = initialText;
  }, [initialText]);

  const warnings = useDebouncedHeuristicWarnings(draft);
  const previewCount = useDebouncedPreview(draft, filePaths);
  const patternNumber = patternIndex + 1;

  const handleCommit = () => {
    if (draft === lastSyncedRef.current) return;
    lastSyncedRef.current = draft;
    onCommit(draft);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center gap-1">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={() => {
            focusedRef.current = false;
            handleCommit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.currentTarget as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(lastSyncedRef.current);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          aria-label={t`Pattern ${patternNumber}`}
          className={cn(
            'h-7 flex-1 font-mono text-xs',
            warnings.length > 0 ? 'border-amber-500/60 focus-visible:ring-amber-500/40' : '',
          )}
          data-testid="settings-okignore-row-input"
        />
        <WarningIndicator warnings={warnings} />
      </div>
      <PatternPreview count={previewCount} />
    </div>
  );
}

function AddPatternRow({
  onAdd,
  placeholder,
  rejectionFlashKey,
  filePaths,
}: {
  onAdd: (text: string) => void;
  placeholder: string;
  rejectionFlashKey: string | null;
  filePaths: ReadonlyArray<string>;
}) {
  const { t } = useLingui();
  const [pending, setPending] = useState('');
  const warnings = useDebouncedHeuristicWarnings(pending);
  const previewCount = useDebouncedPreview(pending, filePaths);
  const flashing = useRejectionFlash(rejectionFlashKey);

  const commit = () => {
    const next = pending.trim();
    if (next.length === 0) return;
    onAdd(next);
    setPending('');
  };

  return (
    <div className="flex flex-col gap-0.5" data-testid="settings-okignore-add">
      <div className="flex items-center gap-2">
        <Input
          value={pending}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={placeholder}
          aria-label={t`New ignore pattern`}
          className={cn(
            'h-8 text-sm',
            flashing
              ? 'border-destructive ring-2 ring-destructive/30 focus-visible:ring-destructive/50'
              : warnings.length > 0
                ? 'border-amber-500/60 focus-visible:ring-amber-500/40'
                : '',
          )}
          data-testid="settings-okignore-add-input"
          data-rejection-flashing={flashing ? 'true' : undefined}
        />
        <WarningIndicator warnings={warnings} />
        <Button
          size="sm"
          onClick={commit}
          disabled={pending.trim().length === 0}
          data-testid="settings-okignore-add-button"
        >
          <Trans>Add pattern</Trans>
        </Button>
      </div>
      <PatternPreview count={previewCount} />
    </div>
  );
}

function WarningIndicator({ warnings }: { warnings: OkignoreWarning[] }) {
  const { t } = useLingui();
  if (warnings.length === 0) {
    return (
      <span
        aria-hidden="true"
        className="flex w-4 shrink-0 justify-center"
        data-testid="settings-okignore-warning-indicator"
        data-warnings="0"
      />
    );
  }
  const summary = warnings.map((w) => w.message).join(' ');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-live="polite"
          aria-label={t`Pattern warnings: ${summary}`}
          className="flex w-4 shrink-0 cursor-help justify-center text-amber-500"
          data-testid="settings-okignore-warning-indicator"
          data-warnings={String(warnings.length)}
        >
          <AlertTriangle aria-hidden="true" className="size-3.5" />
          <span className="sr-only">{summary}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <ul className="list-disc space-y-1 pl-4">
          {warnings.map((w) => (
            <li key={w.code}>{w.message}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

function SavedIndicator({ visible }: { visible: boolean }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className="flex w-4 shrink-0 justify-center text-emerald-600"
      data-testid="settings-okignore-saved-indicator"
    >
      {visible ? (
        <>
          <Check aria-hidden="true" className="size-3.5" />
          <span className="sr-only">
            <Trans>Saved</Trans>
          </span>
        </>
      ) : null}
    </span>
  );
}

export function parseRows(text: string): string[] {
  return listPatterns(parseOkignoreDoc(text)).map((p) => p.text);
}

function indexToSortId(patternIndex: number): string {
  return `okignore-pattern-${patternIndex}`;
}

function sortIdToIndex(id: string): number {
  const m = id.match(/^okignore-pattern-(\d+)$/);
  if (!m) return -1;
  const n = Number.parseInt(m[1] ?? '', 10);
  return Number.isNaN(n) ? -1 : n;
}

function rowFlashKey(text: string, patternIndex: number): string {
  return `${patternIndex}::${text}`;
}

function pickOkignoreDetail(
  error: ConfigValidationError,
): { detail: string; lineNumber?: number } | null {
  if (!isKnownConfigError(error)) return null;
  if (error.code !== 'OKIGNORE_INVALID') return null;
  return { detail: error.detail, lineNumber: error.lineNumber };
}

function useDebouncedHeuristicWarnings(input: string): OkignoreWarning[] {
  const [warnings, setWarnings] = useState<OkignoreWarning[]>(() =>
    input.length === 0 ? [] : checkHeuristicWarnings(input),
  );
  useEffect(() => {
    if (input.length === 0) {
      setWarnings([]);
      return;
    }
    const t = setTimeout(() => {
      setWarnings(checkHeuristicWarnings(input));
    }, HEURISTIC_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input]);
  return warnings;
}

function useDebouncedPreview(pattern: string, filePaths: ReadonlyArray<string>): number | null {
  const trimmed = pattern.trim();
  const [count, setCount] = useState<number | null>(() =>
    trimmed.length === 0 ? null : countMatches(trimmed, filePaths),
  );
  useEffect(() => {
    if (trimmed.length === 0) {
      setCount(null);
      return;
    }
    const t = setTimeout(() => {
      setCount(countMatches(trimmed, filePaths));
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [trimmed, filePaths]);
  return count;
}

function PatternPreview({ count }: { count: number | null }) {
  if (count === null) {
    return (
      <span
        aria-hidden="true"
        className="block h-3.5"
        data-testid="settings-okignore-preview"
        data-preview-state="hidden"
      />
    );
  }
  const isZero = count === 0;
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="settings-okignore-preview"
      data-preview-state="visible"
      data-preview-count={String(count)}
      className={cn('block text-xs', isZero ? 'text-muted-foreground/70' : 'text-muted-foreground')}
    >
      <Plural value={count} one="matches # file" other="matches # files" />
      {isZero ? (
        <span className="ml-1 text-muted-foreground/60">
          <Trans>(some may already be hidden by other rules)</Trans>
        </span>
      ) : null}
    </span>
  );
}

export function derivePreviewPaths(
  pages: ReadonlySet<string>,
  pageMeta: ReadonlyMap<string, { docExt?: string }>,
  assetPaths: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const docName of pages) {
    const ext = pageMeta.get(docName)?.docExt ?? '.md';
    out.push(docName + ext);
  }
  for (const path of assetPaths) {
    out.push(path);
  }
  return out;
}

export function readShowAdvanced(): boolean {
  try {
    return globalThis.localStorage?.getItem(SHOW_ADVANCED_LS_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeShowAdvanced(next: boolean): void {
  try {
    globalThis.localStorage?.setItem(SHOW_ADVANCED_LS_KEY, next ? 'true' : 'false');
  } catch (e) {
    console.debug(
      '[OkignoreSection] localStorage unavailable; advanced toggle will not persist:',
      e,
    );
  }
}

function useShowAdvanced(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabledState] = useState<boolean>(() => readShowAdvanced());
  const setEnabled = (next: boolean) => {
    setEnabledState(next);
    writeShowAdvanced(next);
  };
  return [enabled, setEnabled];
}

function useRejectionFlash(key: string | null): boolean {
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (key === null) return;
    setFlashing(true);
    const t = setTimeout(() => setFlashing(false), REJECTION_FLASH_MS);
    return () => clearTimeout(t);
  }, [key]);
  return flashing;
}

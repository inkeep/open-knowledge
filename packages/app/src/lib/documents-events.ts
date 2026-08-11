import type { SkillScope } from '@inkeep/open-knowledge-core';
import { DerivedViewChannelSchema } from '@inkeep/open-knowledge-core';
import type { DerivedViewChannel } from '@/lib/cc1';

const DOCUMENTS_CHANGED_EVENT = 'open-knowledge:documents-changed';
const DERIVED_VIEW_CHANNELS = new Set(DerivedViewChannelSchema.options);

interface DocumentsChangedDetail {
  channels: DerivedViewChannel[];
}

function normalizeChannels(channels: unknown): DerivedViewChannel[] {
  if (channels === undefined || !Array.isArray(channels)) return ['files'];
  return [
    ...new Set(
      channels.filter((channel): channel is DerivedViewChannel =>
        DERIVED_VIEW_CHANNELS.has(channel),
      ),
    ),
  ];
}

export function emitDocumentsChanged(channels: DerivedViewChannel[] = ['files']): void {
  window.dispatchEvent(
    new CustomEvent<DocumentsChangedDetail>(DOCUMENTS_CHANGED_EVENT, {
      detail: { channels: normalizeChannels(channels) },
    }),
  );
}

export function subscribeToDocumentsChanged(
  onChange: (channels: DerivedViewChannel[]) => void,
): () => void {
  const listener = (event: Event) => {
    const channels =
      event instanceof CustomEvent
        ? (event as CustomEvent<DocumentsChangedDetail>).detail?.channels
        : undefined;
    onChange(normalizeChannels(channels));
  };
  window.addEventListener(DOCUMENTS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(DOCUMENTS_CHANGED_EVENT, listener);
}

/**
 * Local-target existence follows the workspace file inventory. The dedicated
 * channel is the precise signal, while `files` is its correctness backstop when
 * a watcher batch changes inventory but produces no assessment-generation edge.
 */
export function invalidatesLocalTargetAudit(channels: readonly DerivedViewChannel[]): boolean {
  return channels.includes('local-targets') || channels.includes('files');
}

// Doc-persisted relays the CC1 `disk-ack` frame's docName — the one per-doc
// push channel — for consumers that react to "this document's bytes just
// reached disk" (the validation-freshness per-doc re-audit). Kept separate
// from documents-changed: derived-view channels are doc-anonymous signals,
// while this event's whole value is the docName it names.
const DOC_PERSISTED_EVENT = 'open-knowledge:doc-persisted';

interface DocPersistedDetail {
  docName: string;
}

export function emitDocPersisted(docName: string): void {
  window.dispatchEvent(
    new CustomEvent<DocPersistedDetail>(DOC_PERSISTED_EVENT, { detail: { docName } }),
  );
}

export function subscribeToDocPersisted(onPersisted: (docName: string) => void): () => void {
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const docName = (event as CustomEvent<DocPersistedDetail>).detail?.docName;
    if (typeof docName === 'string' && docName.length > 0) onPersisted(docName);
  };
  window.addEventListener(DOC_PERSISTED_EVENT, listener);
  return () => window.removeEventListener(DOC_PERSISTED_EVENT, listener);
}

// Branch-changed is a side-channel event for surfaces that display the
// current git branch (sidebar footer, editor footer). Emitted by the
// DocumentContext branch dispatchers (`observeBranch`, `onBranchSwitched`),
// which centralize every branch-source path (boot fetch, CC1
// `server-info`, CC1 `branch-switched`, reconnect refresh). `null` means
// no git checkout or detached HEAD — UI consumers hide the row.
const BRANCH_CHANGED_EVENT = 'open-knowledge:branch-changed';

interface BranchChangedDetail {
  branch: string | null;
}

export function emitBranchChanged(branch: string | null): void {
  window.dispatchEvent(
    new CustomEvent<BranchChangedDetail>(BRANCH_CHANGED_EVENT, {
      detail: { branch },
    }),
  );
}

export function subscribeToBranchChanged(onChange: (branch: string | null) => void): () => void {
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = (event as CustomEvent<BranchChangedDetail>).detail;
    onChange(detail?.branch ?? null);
  };
  window.addEventListener(BRANCH_CHANGED_EVENT, listener);
  return () => window.removeEventListener(BRANCH_CHANGED_EVENT, listener);
}

// Templates-changed is frontend-only — not a CC1 derived-view channel.
// `templates_available` is computed by the folder-config endpoint from
// disk state; mutations come through `/api/template` (PUT/DELETE) which
// the server writes synchronously, so a local broadcast after the
// request resolves is sufficient to fan out re-fetches across all
// `useFolderConfig` instances. Avoids touching `DerivedViewChannelSchema`
// (shared with the server CC1 surface) for a purely-client concern.
const TEMPLATES_CHANGED_EVENT = 'open-knowledge:templates-changed';

export function emitTemplatesChanged(): void {
  window.dispatchEvent(new CustomEvent(TEMPLATES_CHANGED_EVENT));
}

export function subscribeToTemplatesChanged(onChange: () => void): () => void {
  const listener = () => onChange();
  window.addEventListener(TEMPLATES_CHANGED_EVENT, listener);
  return () => window.removeEventListener(TEMPLATES_CHANGED_EVENT, listener);
}

// Skills-changed is the SAME-WINDOW fast path: a local broadcast so the window
// that made a skill mutation (write/delete/rename/install/restore via
// `/api/skill*`) re-fetches immediately. CROSS-client freshness (another client
// — e.g. the preview browser vs. the desktop app — mutating a skill) rides the
// CC1 `files` derived-view channel instead: every skill handler calls
// `signalChannel('files')`, which reaches other clients via SystemDocSubscriber
// → `emitDocumentsChanged(['files'])`, and `useSkills` subscribes to BOTH. So a
// delete in one client updates the list everywhere without a reload.
const SKILLS_CHANGED_EVENT = 'open-knowledge:skills-changed';

export function emitSkillsChanged(): void {
  window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT));
}

export function subscribeToSkillsChanged(onChange: () => void): () => void {
  const listener = () => onChange();
  window.addEventListener(SKILLS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(SKILLS_CHANGED_EVENT, listener);
}

// Optimistic cross-scope-move overlay. A scope-move copies the whole bundle to
// the destination and deletes the source LAST, so the source row lingers in the
// dock through the (potentially slow) copy. A mover hides the source row the
// instant it's clicked and clears the hint once the move settles — on success
// the delete has already removed it; on failure the row must come back.
// `useSkills` filters hidden keys out of its list, so every consumer (dock,
// sidebar, Settings) reflects the pending move uniformly.
const hiddenMovingSkills = new Set<string>();
const movingSkillKey = (scope: SkillScope, name: string) => `${scope}\u0000${name}`;

export function beginOptimisticSkillMove(fromScope: SkillScope, name: string): void {
  hiddenMovingSkills.add(movingSkillKey(fromScope, name));
  emitSkillsChanged();
}

export function endOptimisticSkillMove(fromScope: SkillScope, name: string): void {
  if (hiddenMovingSkills.delete(movingSkillKey(fromScope, name))) emitSkillsChanged();
}

/** Drop rows a scope-move is optimistically relocating away from their source. */
export function applyOptimisticSkillMoves<T extends { scope: SkillScope; name: string }>(
  skills: readonly T[],
): readonly T[] {
  if (hiddenMovingSkills.size === 0) return skills;
  return skills.filter((s) => !hiddenMovingSkills.has(movingSkillKey(s.scope, s.name)));
}

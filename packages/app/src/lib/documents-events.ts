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

export function invalidatesLocalTargetAudit(channels: readonly DerivedViewChannel[]): boolean {
  return channels.includes('local-targets') || channels.includes('files');
}

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

const TEMPLATES_CHANGED_EVENT = 'open-knowledge:templates-changed';

export function emitTemplatesChanged(): void {
  window.dispatchEvent(new CustomEvent(TEMPLATES_CHANGED_EVENT));
}

export function subscribeToTemplatesChanged(onChange: () => void): () => void {
  const listener = () => onChange();
  window.addEventListener(TEMPLATES_CHANGED_EVENT, listener);
  return () => window.removeEventListener(TEMPLATES_CHANGED_EVENT, listener);
}

const SKILLS_CHANGED_EVENT = 'open-knowledge:skills-changed';

export function emitSkillsChanged(): void {
  window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT));
}

export function subscribeToSkillsChanged(onChange: () => void): () => void {
  const listener = () => onChange();
  window.addEventListener(SKILLS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(SKILLS_CHANGED_EVENT, listener);
}

const SKILL_SCOPE_MOVED_EVENT = 'open-knowledge:skill-scope-moved';

export interface SkillScopeMovedDetail {
  name: string;
  fromScope: SkillScope;
  toScope: SkillScope;
}

export function emitSkillScopeMoved(detail: SkillScopeMovedDetail): void {
  window.dispatchEvent(new CustomEvent(SKILL_SCOPE_MOVED_EVENT, { detail }));
}

export function subscribeToSkillScopeMoved(
  onMove: (detail: SkillScopeMovedDetail) => void,
): () => void {
  const listener = (e: Event) => onMove((e as CustomEvent<SkillScopeMovedDetail>).detail);
  window.addEventListener(SKILL_SCOPE_MOVED_EVENT, listener);
  return () => window.removeEventListener(SKILL_SCOPE_MOVED_EVENT, listener);
}

const hiddenMovingSkills = new Set<string>();
const movingSkillKey = (scope: SkillScope, name: string) => `${scope}\u0000${name}`;

export function beginOptimisticSkillMove(fromScope: SkillScope, name: string): void {
  hiddenMovingSkills.add(movingSkillKey(fromScope, name));
  emitSkillsChanged();
}

export function endOptimisticSkillMove(fromScope: SkillScope, name: string): void {
  if (hiddenMovingSkills.delete(movingSkillKey(fromScope, name))) emitSkillsChanged();
}

const pendingSkillWrites = new Map<string, number>();

export function beginSkillWrite(scope: SkillScope, name: string): void {
  const key = movingSkillKey(scope, name);
  pendingSkillWrites.set(key, (pendingSkillWrites.get(key) ?? 0) + 1);
  emitSkillsChanged();
}

export function endSkillWrite(scope: SkillScope, name: string): void {
  const key = movingSkillKey(scope, name);
  const count = pendingSkillWrites.get(key);
  if (count === undefined) return;
  if (count <= 1) pendingSkillWrites.delete(key);
  else pendingSkillWrites.set(key, count - 1);
  emitSkillsChanged();
}

export function isSkillWritePending(scope: SkillScope, name: string): boolean {
  return pendingSkillWrites.has(movingSkillKey(scope, name));
}

export function pendingSkillWritesKey(): string {
  return [...pendingSkillWrites.keys()].sort().join('\u0001');
}

export function isOptimisticallyMoving(scope: SkillScope, name: string): boolean {
  return hiddenMovingSkills.has(movingSkillKey(scope, name));
}

export function applyOptimisticSkillMoves<T extends { scope: SkillScope; name: string }>(
  skills: readonly T[],
): readonly T[] {
  if (hiddenMovingSkills.size === 0) return skills;
  return skills.filter((s) => !hiddenMovingSkills.has(movingSkillKey(s.scope, s.name)));
}

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

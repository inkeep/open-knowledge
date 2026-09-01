import {
  hashFromDocName,
  hashFromSkillPreview,
  isSameHash,
  type SkillPreviewHashTarget,
} from '@/lib/doc-hash';

export function openManagedArtifactTab(docName: string): void {
  if (typeof window === 'undefined') return;
  const hash = hashFromDocName(docName);
  if (!isSameHash(window.location.hash, hash)) window.location.hash = hash;
}

export function openSkillPreviewTab(target: SkillPreviewHashTarget): void {
  if (typeof window === 'undefined') return;
  const hash = hashFromSkillPreview(target);
  if (window.location.hash !== hash) window.location.hash = hash;
}

import type { SkillScope } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { Eye } from 'lucide-react';
import { useRef } from 'react';
import { ProseFindBar } from '@/components/ProseFindBar';
import { SkillMarkdownLoader } from '@/components/SkillMarkdownLoader';
import { TextViewer } from '@/components/TextViewer';
import { useFindInViewer } from '@/hooks/use-find-in-viewer';
import { loadSkillFileText } from '@/lib/skills-api';

/** Bundle-file extensions rendered as formatted markdown rather than source. */
const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx']);

/**
 * Read-only viewer for a skill's bundle files (scripts, built-in references,
 * and any non-editable file — editable project/global `.md` references open as
 * live docs instead, not through here).
 *
 * A skill bundle file is read through the scope-aware `/api/skill-file`
 * endpoint, so it works for GLOBAL skills whose files live under `~/.ok/skills/`
 * — outside the project content dir the asset server knows about.
 *
 * Dispatch by extension:
 *   - `.md` / `.mdx` → `SkillMarkdownLoader` (formatted read-only prose).
 *   - everything else (scripts, json, yaml, …) → `TextViewer`'s read-only
 *     CodeMirror source render.
 *
 * Both are wrapped with the eye read-only banner so the surface reads as
 * read-only like the skill preview does (§8.11) — the file opens with no edit
 * affordance, and without the banner that was invisible.
 */
export function SkillFileViewer({
  scope,
  name,
  path,
  host,
}: {
  scope: SkillScope;
  name: string;
  path: string;
  /** Which same-named bundle this file belongs to; omitted = by-name default. */
  host?: string;
}) {
  const { t } = useLingui();
  // §8.4: Cmd/Ctrl+F inside the read-only surface opens the in-viewer find bar
  // (prose files; the CodeMirror text viewer has its own search built in).
  const proseRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inertRef = useRef<HTMLDivElement | null>(null);
  // Window-level capture scoped to events inside this viewer — the container
  // is a static element, so it can't own a key handler itself (a11y), and the
  // shortcut should work regardless of which child holds focus.
  const fileName = path.split('/').pop() ?? path;
  const dot = fileName.lastIndexOf('.');
  const extension = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  const isMarkdown = MARKDOWN_EXTENSIONS.has(extension);
  // Prose files only — a text file's CodeMirror owns Cmd+F itself.
  const { findOpen, setFindOpen } = useFindInViewer(isMarkdown ? rootRef : inertRef);

  const viewer = MARKDOWN_EXTENSIONS.has(extension) ? (
    <SkillMarkdownLoader scope={scope} name={name} path={path} host={host} fileName={fileName} />
  ) : (
    <TextViewer
      fileName={fileName}
      extension={extension}
      loadText={(signal: AbortSignal) => loadSkillFileText({ scope, name, path, host }, signal)}
    />
  );

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col">
      {isMarkdown && findOpen ? (
        <ProseFindBar containerRef={proseRef} onClose={() => setFindOpen(false)} />
      ) : null}
      {/* Read-only affordance: a skill bundle file opens read-only, so mark it
          with the same eye banner the skill preview uses — without it the
          read-only state was invisible (§8.11). */}
      <div className="flex shrink-0 items-center gap-1.5 border-border border-b bg-muted/35 px-3 py-2 text-muted-foreground text-sm">
        <Eye className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{t`Read-only file in the ${name} skill`}</span>
      </div>
      <div ref={proseRef} className="min-h-0 flex-1">
        {viewer}
      </div>
    </div>
  );
}

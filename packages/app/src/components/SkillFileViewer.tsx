import type { SkillScope } from '@inkeep/open-knowledge-core';
import { SkillMarkdownLoader } from '@/components/SkillMarkdownLoader';
import { TextViewer } from '@/components/TextViewer';
import { loadSkillFileText } from '@/lib/skills-api';

/** Bundle-file extensions rendered as formatted markdown rather than source. */
const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx']);

/**
 * Read-only viewer for a skill's bundle files (`references/**` / `scripts/**`).
 *
 * Unlike a content-dir asset, a skill bundle file is read through the
 * scope-aware `/api/skill-file` endpoint, so it works for GLOBAL skills whose
 * files live under `~/.ok/skills/` — outside the project content dir the asset
 * server knows about. (Project `.md` references open as editable content docs
 * instead; this viewer is for everything that isn't a project-scope `.md`.)
 *
 * Dispatch by extension:
 *   - `.md` / `.mdx` → `SkillMarkdownLoader`, which renders the file as
 *     formatted, read-only prose (same look as the editor, no CRDT binding).
 *   - everything else (scripts, json, …) → `TextViewer`'s read-only CodeMirror
 *     source render, so language highlighting + theme + the loading / error
 *     panes match the asset text viewer.
 */
export function SkillFileViewer({
  scope,
  name,
  path,
}: {
  scope: SkillScope;
  name: string;
  path: string;
}) {
  const fileName = path.split('/').pop() ?? path;
  const dot = fileName.lastIndexOf('.');
  const extension = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';

  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return <SkillMarkdownLoader scope={scope} name={name} path={path} fileName={fileName} />;
  }

  return (
    <TextViewer
      fileName={fileName}
      extension={extension}
      loadText={(signal: AbortSignal) => loadSkillFileText({ scope, name, path }, signal)}
    />
  );
}

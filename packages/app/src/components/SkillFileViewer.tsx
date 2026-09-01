import type { SkillScope } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { Eye } from 'lucide-react';
import { useRef } from 'react';
import { ProseFindBar } from '@/components/ProseFindBar';
import { SkillMarkdownLoader } from '@/components/SkillMarkdownLoader';
import { TextViewer } from '@/components/TextViewer';
import { useFindInViewer } from '@/hooks/use-find-in-viewer';
import { loadSkillFileText } from '@/lib/skills-api';

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx']);

export function SkillFileViewer({
  scope,
  name,
  path,
  host,
}: {
  scope: SkillScope;
  name: string;
  path: string;
  host?: string;
}) {
  const { t } = useLingui();
  const proseRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inertRef = useRef<HTMLDivElement | null>(null);
  const fileName = path.split('/').pop() ?? path;
  const dot = fileName.lastIndexOf('.');
  const extension = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  const isMarkdown = MARKDOWN_EXTENSIONS.has(extension);
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
      {}
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

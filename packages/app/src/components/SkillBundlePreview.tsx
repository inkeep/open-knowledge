import type { SkillPreview as SkillPreviewData, SkillScope } from '@inkeep/open-knowledge-core';
import {
  estimateSkillCost,
  extractFrontmatterTags,
  skillFileLiveDocName,
  skillLiveDocName,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlignLeft, Eye, Gauge, Tag, Type } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { PropertyDisplayRow } from '@/components/PropertyDisplayRow';
import { ProseFindBar } from '@/components/ProseFindBar';
import { SkillCostValue } from '@/components/SkillCostValue';
import { SkillMarkdownViewer } from '@/components/SkillMarkdownViewer';
import { SkillModeBanner } from '@/components/SkillModeBanner';
import { useFindInViewer } from '@/hooks/use-find-in-viewer';
import { subscribeToSkillsChanged } from '@/lib/documents-events';
import { skillTint } from '@/lib/skill-tint';
import { fetchSkillPreview } from '@/lib/skills-api';

const SKILL_MD = 'SKILL.md';

const previewCache = new Map<string, SkillPreviewData>();

interface SelectedFile {
  path: string;
  content: string;
  md: boolean;
}

interface Props {
  source: string;
  name: string;
  subtitle: string;
  tintKey: string;
  headerActions: ReactNode;
  headerLine: ReactNode;
  noPreviewFallback?: ReactNode;
  reserveRightGutter?: boolean;
  selectedPath?: string;
  scope?: SkillScope;
  onPreviewMeta?: (preview: SkillPreviewData) => void;
  banner?: ReactNode;
  onBundlePathClick?: (path: string) => boolean;
}

export function SkillBundlePreview({
  source,
  name,
  subtitle,
  tintKey,
  headerActions,
  headerLine,
  noPreviewFallback,
  banner,
  reserveRightGutter = false,
  selectedPath: selectedPathProp,
  scope,
  onBundlePathClick,
  onPreviewMeta,
}: Props) {
  const { t } = useLingui();
  const cacheKey = `${source}::${name}`;
  const [preview, setPreview] = useState<SkillPreviewData | null>(
    () => previewCache.get(cacheKey) ?? null,
  );
  const [previewLoaded, setPreviewLoaded] = useState(() => previewCache.has(cacheKey));
  const selectedPath = selectedPathProp ?? SKILL_MD;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { findOpen, setFindOpen } = useFindInViewer(rootRef);

  useEffect(() => {
    const key = `${source}::${name}`;
    const controller = new AbortController();
    if (!previewCache.has(key)) {
      void fetchSkillPreview({ source, name }, controller.signal).then((res) => {
        if (controller.signal.aborted) return;
        if (res.ok) {
          previewCache.set(key, res);
          setPreview(res);
        }
        setPreviewLoaded(true);
      });
    }
    const unsub = subscribeToSkillsChanged(() => previewCache.clear());
    return () => {
      controller.abort();
      unsub();
    };
  }, [source, name]);

  useEffect(() => {
    if (preview) onPreviewMeta?.(preview);
  }, [preview, onPreviewMeta]);

  const desc = preview?.description;
  const tags = preview ? parseSkillTags(preview.skillMd) : [];
  const cost = preview ? estimateSkillCost(preview) : null;
  const selected: SelectedFile | null =
    selectedPath === SKILL_MD
      ? preview
        ? { path: `${preview.name} SKILL.md`, content: preview.skillMd, md: true }
        : null
      : (() => {
          const f = preview?.files?.find((x) => x.relPath === selectedPath);
          if (!f) return null;
          return {
            path: f.relPath,
            content: f.content ?? t`(binary file, not previewable)`,
            md: f.content !== null && /\.mdx?$/.test(f.relPath),
          };
        })();

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col">
      {findOpen ? (
        <ProseFindBar containerRef={scrollRef} onClose={() => setFindOpen(false)} />
      ) : null}
      {}
      <SkillModeBanner
        icon={<Eye className="size-4" aria-hidden />}
        actions={headerActions}
        reserveRightGutter={reserveRightGutter}
      >
        {headerLine}
      </SkillModeBanner>

      {preview ? (
        <div
          ref={scrollRef}
          className="editor-doc-scroll min-h-0 flex-1 overflow-auto subtle-scrollbar scroll-fade-mask"
        >
          {}
          {selectedPath === SKILL_MD ? banner : null}
          {}
          {selectedPath === SKILL_MD ? (
            <div className="editor-content-aligned pt-6">
              <div className="space-y-0.5">
                <PropertyDisplayRow icon={<Type className="size-3.5" />} label={t`name`}>
                  <span className="font-mono">{name}</span>
                </PropertyDisplayRow>
                {desc ? (
                  <PropertyDisplayRow
                    icon={<AlignLeft className="size-3.5" />}
                    label={t`description`}
                  >
                    <p className="text-foreground/80">{desc}</p>
                  </PropertyDisplayRow>
                ) : null}
                <PropertyDisplayRow icon={<Tag className="size-3.5" />} label={t`tags`}>
                  {tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {tags.map((tg) => (
                        <span
                          key={tg}
                          className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
                        >
                          {tg}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">
                      <Trans>Empty</Trans>
                    </span>
                  )}
                </PropertyDisplayRow>
                {cost ? (
                  <PropertyDisplayRow icon={<Gauge className="size-3.5" />} label={t`tokens`}>
                    <SkillCostValue size={cost} />
                  </PropertyDisplayRow>
                ) : null}
              </div>
            </div>
          ) : null}

          {selected?.md ? (
            <SkillMarkdownViewer
              flow
              fileName={selected.path}
              text={selected.content}
              linkBaseDocName={
                scope
                  ? skillFileLiveDocName(
                      scope,
                      name,
                      selectedPath === SKILL_MD ? 'SKILL' : selectedPath,
                    )
                  : undefined
              }
              skillPathLinkDocName={scope ? skillLiveDocName(scope, name) : undefined}
              onBundlePathClick={onBundlePathClick}
            />
          ) : selected ? (
            <div className="editor-content-aligned">
              <pre className="overflow-auto whitespace-pre-wrap break-words py-4 font-mono text-xs subtle-scrollbar scroll-fade-mask">
                {selected.content}
              </pre>
            </div>
          ) : null}
        </div>
      ) : !previewLoaded ? (
        <div className="editor-doc-scroll min-h-0 flex-1 overflow-auto subtle-scrollbar scroll-fade-mask">
          <div className="editor-content-aligned pt-6">
            <div className="space-y-3">
              <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
              {['a', 'b', 'c', 'd', 'e'].map((id) => (
                <div key={id} className="h-4 w-11/12 animate-pulse rounded bg-muted" />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-4">
          {noPreviewFallback ?? (
            <div
              className={`flex aspect-[2/1] w-full max-w-xl flex-col justify-end rounded-xl bg-gradient-to-br p-5 ${skillTint(tintKey)}`}
              aria-hidden
            >
              <span className="truncate font-semibold text-2xl text-neutral-900">{name}</span>
              <span className="truncate text-neutral-900/70 text-sm">{subtitle}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function parseSkillTags(skillMd: string): string[] {
  try {
    const { frontmatter } = stripFrontmatter(skillMd);
    if (!frontmatter) return [];
    return extractFrontmatterTags(unwrapFrontmatterFences(frontmatter));
  } catch {
    return [];
  }
}

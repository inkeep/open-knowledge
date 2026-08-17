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

// Per-session preview cache, keyed by source+name. `SkillPreviewTab` is keyed by
// `flavor:source:name`, so every open remounts this component; without a cache it
// re-fetches `/api/skills/preview` and re-flashes the loading skeleton each time.
// Seeding from the cache makes re-opening a skill (and clicking between detected
// skills) instant. A preview is a read-only snapshot, so a cached entry is fine
// until `skills-changed` (manage / import / delete) clears the cache.
const previewCache = new Map<string, SkillPreviewData>();

interface SelectedFile {
  path: string;
  content: string;
  /** Rendered markdown (SKILL.md + `.md`/`.mdx` references) vs raw `<pre>` (scripts). */
  md: boolean;
}

interface Props {
  /** Source handed to `/api/skills/preview`: a repository/website skills.sh
   *  source or a local skill directory for a Detected one. */
  source: string;
  name: string;
  /** Subtitle under the name — the repo (skills.sh) or the harness home (Detected). */
  subtitle: string;
  /** Seed for the avatar + no-preview banner tint. */
  tintKey: string;
  /** The primary Manage/Import action plus any external links — fully owned by
   *  the caller so each source differs. Rendered as a compact top-right cluster. */
  headerActions: ReactNode;
  /** The left-side header sentence ("This is a preview of X…") — caller-owned so
   *  it can bold the name + level and name the exact next action (Import/Manage).
   *  Rendered inline after the eye marker. */
  headerLine: ReactNode;
  /** Shown when there's no readable preview (skills.sh passes its OG image);
   *  falls back to a gradient banner when omitted. */
  noPreviewFallback?: ReactNode;
  /** The right-docked "Show terminal" reveal tab floats over this pane's
   *  top-right corner; shift the action cluster left so they sit in one row. */
  reserveRightGutter?: boolean;
  /** Controlled selected file (`SKILL.md` / a bundle `relPath`), driven by the
   *  sidebar tree via the hash; omit for the SKILL.md-only standalone view. */
  selectedPath?: string;
  /** The skill's scope, when it has a resolved bundle identity (built-in /
   *  imported). Used only to build the relative-link base so `references/*`
   *  links in the rendered SKILL.md resolve to bundle docs instead of rendering
   *  broken (§8.3). Omit for an un-imported explore skill. */
  scope?: SkillScope;
  /** Fires with the fetched preview payload (also on a cache hit) so the caller
   *  can lift response-only metadata (e.g. plugin provenance) into its header. */
  onPreviewMeta?: (preview: SkillPreviewData) => void;
  /** Optional disclosure rendered between the header and the SKILL.md body,
   *  above the properties (e.g. the "part of a full plugin" banner). Only shown
   *  on the SKILL.md view, not when a bundle file is selected. */
  banner?: ReactNode;
  /** Click handler for a `references/…` bundle-path chip in the rendered SKILL.md
   * — switches the preview's selected file in place. Return
   *  `true` to mark the click handled. Omit for previews with no bundle identity. */
  onBundlePathClick?: (path: string) => boolean;
}

/**
 * Full-page read-only preview of ONE skill bundle, laid out to read like a
 * normal document tab: its `SKILL.md` rendered through the editor's own
 * read-only markdown viewer (the same prose it shows once imported), with the
 * read-only properties above it — all in one doc-width column. Bundle-file
 * navigation lives in the sidebar tree only (the in-preview FILES list was
 * removed as redundant). Source-agnostic: repository-backed, website-backed,
 * and local Detected skills all flow through
 * `/api/skills/preview`. Mount with a per-skill `key` so the fetch effect runs
 * once per open and the `AbortController` only fires on unmount, never mid-life.
 */
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
    // Cache miss only — a hit already seeded `preview` above (no fetch, no
    // skeleton). Abort the in-flight fetch on unmount (back / close) so a quick
    // look-and-leave doesn't leave a server-side read running.
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
    // Managing / importing / deleting a skill can change what a re-preview should
    // show, so drop the cache on `skills-changed`.
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
  // Priced client-side from the payload already fetched — `SkillPreview`
  // satisfies the estimator's input, so no adapter, no extra fetch. Null until
  // the preview loads, which keeps the row absent on a failed fetch.
  const cost = preview ? estimateSkillCost(preview) : null;
  const selected: SelectedFile | null =
    selectedPath === SKILL_MD
      ? preview
        ? { path: `${preview.name} SKILL.md`, content: preview.skillMd, md: true }
        : null
      : (() => {
          const f = preview?.files?.find((x) => x.relPath === selectedPath);
          if (!f) return null;
          // Binary files (`content: null`) are shown as a placeholder — a preview
          // renders text, never raw bytes.
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
      {/* Document-like chrome: a single "this is a preview of X — <action> it"
          sentence on the left (eye marker + caller-owned prose that bolds the
          name + level and names the exact next action), and the caller's links /
          Manage cluster on the right. Shared with the edit-in-place banner via
          SkillModeBanner. */}
      <SkillModeBanner
        icon={<Eye className="size-4" aria-hidden />}
        actions={headerActions}
        reserveRightGutter={reserveRightGutter}
      >
        {headerLine}
      </SkillModeBanner>

      {preview ? (
        // One doc-width scroll: properties, then prose, then the file list — each
        // block content-aligned to the same column as the editor body so the
        // whole thing reads like a normal document tab.
        <div
          ref={scrollRef}
          className="editor-doc-scroll min-h-0 flex-1 overflow-auto subtle-scrollbar scroll-fade-mask"
        >
          {/* Plugin-bundle disclosure sits between the header and properties, on
              the SKILL.md view only. */}
          {selectedPath === SKILL_MD ? banner : null}
          {/* Properties describe the SKILL, so only above SKILL.md — not above a
              reference/script the file list navigated to. */}
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
              // Base the relative-link resolution on THIS file's bundle doc so
              // `references/*` links resolve to sibling docs, not broken content
              // paths (§8.3). SKILL.md's bundle rel is `SKILL`; a reference is its
              // own `relPath`.
              linkBaseDocName={
                scope
                  ? skillFileLiveDocName(
                      scope,
                      name,
                      selectedPath === SKILL_MD ? 'SKILL' : selectedPath,
                    )
                  : undefined
              }
              // The skill identity that makes `references/…` chips clickable, and
              // the in-place file switch so a click stays in the preview.
              skillPathLinkDocName={scope ? skillLiveDocName(scope, name) : undefined}
              onBundlePathClick={onBundlePathClick}
            />
          ) : selected ? (
            // ponytail: scripts render as read-only <pre>, no CodeMirror
            // highlighting — a preview only needs the bytes legible.
            <div className="editor-content-aligned">
              <pre className="overflow-auto whitespace-pre-wrap break-words py-4 font-mono text-xs subtle-scrollbar scroll-fade-mask">
                {selected.content}
              </pre>
            </div>
          ) : null}
        </div>
      ) : !previewLoaded ? (
        // Doc-width prose skeleton so the server-side shallow clone reads as
        // "loading this skill", not a blank pane.
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

/** Best-effort tags from a skill's SKILL.md frontmatter (empty on any parse miss). */
function parseSkillTags(skillMd: string): string[] {
  try {
    const { frontmatter } = stripFrontmatter(skillMd);
    if (!frontmatter) return [];
    return extractFrontmatterTags(unwrapFrontmatterFences(frontmatter));
  } catch {
    return [];
  }
}

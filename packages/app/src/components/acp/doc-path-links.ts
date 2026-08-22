/**
 * Turn `.md` / `.mdx` paths that appear in agent prose into in-app links to
 * the docs they name. The resolver classifies a candidate string against
 * three shapes, in order, and only returns a docName the workspace's page
 * list actually contains — an unresolvable path stays plain text so we
 * never route the user to a create-on-open blank tab.
 *
 * The three shapes agents write:
 *
 *   1. Absolute path with a `contentDir` prefix — the OK MCP echoes these
 *      back verbatim (e.g. `/Users/…/public/open-knowledge/reports/foo/REPORT.md`).
 *   2. Repo-root-relative (e.g. `public/open-knowledge/reports/foo/REPORT.md`)
 *      when `contentDir` sits inside a repo — the most common case in
 *      practice.
 *   3. Bare or nested-suffix path (e.g. `reports/foo/REPORT.md` or `REPORT.md`)
 *      resolved by longest-suffix match against the known page set. Ambiguity
 *      wins nothing: two docs ending the same way → no link, so we never
 *      route to the wrong one.
 *
 * The companion remark plugin walks a parsed mdast tree, replacing matched
 * paths in `text` nodes with `link` nodes and wrapping `inlineCode` nodes
 * whose entire value resolves so backticked paths (which agents also write)
 * become clickable while keeping their mono styling. Fenced code blocks and
 * anything already inside a `link` are left alone by construction.
 */

import { docNameFromAbsolutePath } from '@/components/acp/follow-file';
import { hashFromDocName } from '@/lib/doc-hash';
import type { Workspace } from '@/lib/workspace-paths';

export type DocPathResolver = (candidate: string) => string | null;

/**
 * Path chars conservative enough that a false positive in ordinary prose is
 * unlikely: alphanumerics, `.`, `_`, `-`, `/`, `@`. No spaces (typical for source
 * paths agents quote) and no shell metacharacters. `\b` after the extension
 * so a period inside a longer word (`file.mdx.txt`) doesn't match a phantom
 * suffix. Streaming-safe: a half-arrived path simply doesn't match yet — the
 * `\b` ensures we won't match on `foo.m` mid-stream.
 */
const DOC_PATH_REGEX = /(?<![A-Za-z0-9_./@-])[A-Za-z0-9_./@-]+\.(?:md|mdx)\b/g;

export interface BuildDocPathResolverInput {
  readonly workspace: Workspace | null;
  /**
   * The known-doc set the resolver gates existence on. Pass an empty set
   * when the page list isn't authoritative yet — the returned resolver
   * refuses everything rather than routing to a stale target.
   */
  readonly pages: ReadonlySet<string>;
}

export function buildDocPathResolver(input: BuildDocPathResolverInput): DocPathResolver | null {
  const { workspace, pages } = input;
  if (workspace === null || pages.size === 0) return null;

  return (candidate: string): string | null => {
    // Strip a trailing `#anchor` if present — we route to the doc, not a
    // specific heading (the anchor would need a separate settled-scroll pass
    // that follow-file doesn't do either). Anchor-text characters
    // (alphanumerics, `-`) overlap the regex char class, but `#` is not —
    // regex-matched candidates stop before `#` by construction. This
    // explicit strip handles the `inlineCode` path, where the full node
    // value (including any `#anchor`) arrives unfiltered.
    const hashIdx = candidate.indexOf('#');
    const path = (hashIdx === -1 ? candidate : candidate.slice(0, hashIdx)).replace(/^@/, '');
    if (path === '') return null;

    // Try 1: absolute path with contentDir prefix.
    const asAbsolute = docNameFromAbsolutePath(path, workspace);
    if (asAbsolute !== null && pages.has(asAbsolute)) return asAbsolute;

    // Try 2: repo-root-relative or any path that becomes absolute when joined
    // to the workspace's parent — the common case where `contentDir` is
    // `<repo>/public/open-knowledge` and the agent quotes
    // `public/open-knowledge/reports/…`. Compose the path onto the workspace's
    // contentDir and re-run the absolute resolver; the composed string starts
    // with contentDir by construction, so it always classifies as "inside".
    //
    // Priority note: this runs before Try 3's exact `pages.has(stripped)`, so a
    // composed hit outranks an exact page-set match if `contentDir`'s last
    // segment repeats inside the tree (e.g. contentDir ends in `docs` and a
    // page named `docs/intro` is quoted as `docs/intro.md`). In practice the
    // composed lookup falls back through `docNameFromAbsolutePath`'s
    // strict-prefix check, so this only matters for the narrow case where
    // both resolve — and when they do, the composed result equals the exact
    // match anyway (same page, same docName).
    const composed = joinWorkspaceRelative(workspace, path);
    if (composed !== null) {
      const composedDoc = docNameFromAbsolutePath(composed, workspace);
      if (composedDoc !== null && pages.has(composedDoc)) return composedDoc;
    }

    // Try 3: longest-suffix match against the page set. Strip the extension
    // (docNames are extension-less) and look for exactly one docName that
    // ends with `/${stripped}` (subfolder-tail) or equals `stripped` (bare).
    // Ambiguity — two candidates — deliberately returns null: we would rather
    // leave a path plain than route the user to the wrong file. `pages.has()`
    // is the sole existence + validity gate — a doc in the tracked set is
    // user-content regardless of its dot-segment prefix (`.changeset/foo`,
    // `.github/foo`), which is why the sanitizer from follow-the-file (built
    // for autonomous navigation, not user-clicked links) is not applied here.
    const stripped = stripMarkdownExt(path);
    if (stripped === null) return null;
    if (pages.has(stripped)) return stripped;
    const suffix = `/${stripped}`;
    let match: string | null = null;
    for (const doc of pages) {
      if (doc === stripped || doc.endsWith(suffix)) {
        if (match !== null) return null;
        match = doc;
      }
    }
    return match;
  };
}

/**
 * Build an absolute-looking path from a relative one by joining against the
 * workspace's contentDir path segments — the repo-root-relative shape (Try 2
 * in the resolver). Handles the case where `contentDir` is `<repo>/public/…`
 * and the agent writes `public/…`, and the general case where the relative
 * path is a strict suffix of what contentDir already contains.
 *
 * Null when there's no obvious composition (e.g. paths that don't share any
 * segments with contentDir); the resolver's suffix-match path handles those.
 */
function joinWorkspaceRelative(workspace: Workspace, relative: string): string | null {
  if (relative.startsWith('/') || relative.startsWith('\\')) return null;
  const sep = workspace.pathSeparator;
  const normalize = (p: string): string => (sep === '\\' ? p.replaceAll('\\', '/') : p);
  const contentDir = normalize(workspace.contentDir).replace(/\/$/, '');
  const normalizedRel = normalize(relative);
  const contentSegments = contentDir.split('/');
  const relFirstSegment = normalizedRel.split('/')[0];
  if (relFirstSegment === undefined || relFirstSegment === '') return null;
  for (let i = contentSegments.length - 1; i >= 0; i -= 1) {
    if (contentSegments[i] === relFirstSegment) {
      const prefix = contentSegments.slice(0, i).join('/');
      return prefix === '' ? `/${normalizedRel}` : `${prefix}/${normalizedRel}`;
    }
  }
  return null;
}

function stripMarkdownExt(path: string): string | null {
  const match = /\.(?:md|mdx)$/i.exec(path);
  if (match === null) return null;
  return path.slice(0, -match[0].length);
}

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdastNode[];
}

/**
 * Module-scoped current resolver — the plugin reads this at fire time rather
 * than closing over a per-render argument. Streamdown's incremental parser
 * caches transformers by identity across renders, so a plugin that closes
 * over an early null-resolver render sticks with that null across the rest
 * of the session (verified empirically: the closure argument is non-null at
 * factory-call time on the render that produces the plugin, but the same
 * transformer fires under the SAME cached processor and sees null).
 *
 * A singleton is a real design compromise (all AgentMarkdown instances share
 * one resolver), but all of them derive it from the same workspace + page
 * list, so the target value is the same everywhere. ThreadView owns the
 * writes; AgentMarkdown instances only READ (via a React context for the
 * ready-shape they key on).
 */
let currentResolver: DocPathResolver | null = null;

export function setDocPathResolver(resolver: DocPathResolver | null): void {
  currentResolver = resolver;
}

/**
 * Remark plugin that rewrites matched `.md` / `.mdx` paths in `text` and
 * whole-value `inlineCode` nodes into `link` nodes pointing at the OK hash
 * router. Skips anything inside an existing `link` (double-linking would
 * produce invalid mdast) and never descends into `code` (fenced code blocks
 * are hands-off — they carry their content in `value`, not `children`, and
 * a walk over `children` misses them by construction, same as
 * `remark-hard-breaks`). A null `currentResolver` short-circuits the walk
 * (no allocations) so AgentMarkdown pays nothing before the workspace and
 * page list resolve.
 */
export function remarkDocPathLinks() {
  // Unified's `remarkPlugins` accepts Plugin factories (`() => Transformer`),
  // not raw Transformers. Curry through an extra layer so unified sees a
  // Plugin at registration time and stores the Transformer in the chain.
  return () =>
    (tree: MdastNode): void => {
      const resolver = currentResolver;
      if (resolver === null) return;
      try {
        rewriteNode(tree, resolver);
      } catch (err) {
        // Never let this plugin take down markdown rendering. AgentMarkdown's
        // ErrorBoundary otherwise catches and falls back to plain text — the
        // whole message goes unstyled — for what is at worst a partial-linking
        // outcome (rewriteNode mutates `node.children = next` in place as it
        // descends, so a mid-walk throw leaves some subtrees rewritten and
        // some not — not an untouched tree).
        console.warn('[remarkDocPathLinks] rewrite failed, partial rewrites may remain', err);
      }
    };
}

function rewriteNode(node: MdastNode | undefined, resolver: DocPathResolver): void {
  if (node === undefined || node === null) return;
  const children = node.children;
  if (children === undefined) return;
  const next: MdastNode[] = [];
  for (const child of children) {
    if (child === undefined || child === null) continue;
    if (child.type === 'link') {
      next.push(child);
      continue;
    }
    if (child.type === 'text' && typeof child.value === 'string') {
      next.push(...splitTextByPaths(child.value, resolver));
      continue;
    }
    if (child.type === 'inlineCode' && typeof child.value === 'string') {
      const doc = resolver(child.value.trim());
      if (doc === null) {
        next.push(child);
      } else {
        next.push({
          type: 'link',
          url: hashFromDocName(doc),
          title: null,
          children: [child],
        });
      }
      continue;
    }
    rewriteNode(child, resolver);
    next.push(child);
  }
  node.children = next;
}

function splitTextByPaths(value: string, resolver: DocPathResolver): MdastNode[] {
  const out: MdastNode[] = [];
  let cursor = 0;
  const regex = new RegExp(DOC_PATH_REGEX.source, DOC_PATH_REGEX.flags);
  let match: RegExpExecArray | null = regex.exec(value);
  while (match !== null) {
    const [candidate] = match;
    const start = match.index;
    const doc = resolver(candidate);
    if (doc !== null) {
      if (start > cursor) {
        out.push({ type: 'text', value: value.slice(cursor, start) });
      }
      out.push({
        type: 'link',
        url: hashFromDocName(doc),
        title: null,
        children: [{ type: 'text', value: candidate }],
      });
      cursor = start + candidate.length;
    }
    match = regex.exec(value);
  }
  if (cursor === 0) return [{ type: 'text', value }];
  if (cursor < value.length) {
    out.push({ type: 'text', value: value.slice(cursor) });
  }
  return out;
}

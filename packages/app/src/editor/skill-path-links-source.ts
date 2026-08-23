/**
 * Source-mode counterpart of the WYSIWYG skill-path affordance
 * (`extensions/skill-path-links.ts`): in a skill doc's raw markdown, an
 * inline-code span whose WHOLE content is bundle-path-shaped
 * (`references/…` / `scripts/…`) gets a link affordance, and clicking it opens
 * the bundle file through the same scope-aware skill-file route. Decoration
 * only — the document bytes are untouched, and both surfaces share the ONE
 * `BUNDLE_PATH_RE` / `skillDocTarget` so they can never disagree on what
 * counts as a path.
 */
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension, Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { requestSkillsDockExpanded } from '@/components/skills-dock-expanded-store';
import { getSkillNameSnapshot, skillRefNavHashForHit } from '@/lib/skill-name-set';
import {
  BUNDLE_PATH_RE,
  isSkillRefCandidate,
  SKILL_REF_RE,
  skillBundlePathNavHash,
  skillDocTarget,
} from './extensions/skill-path-links';

/** Pure builder (exported for unit tests, mirrors source-polish's pattern):
 *  decorates the INNER text of matching InlineCode nodes, never the backticks. */
function namesAsSet(): ReadonlySet<string> | null {
  const snapshot = getSkillNameSnapshot();
  return snapshot === null ? null : new Set(snapshot.keys());
}

export function buildSkillPathDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  knownSkillNames?: ReadonlySet<string> | null,
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  // `/skill-name` prose references (outside code spans): mirror the WYSIWYG
  // classification — installed links, unknown slug renders missing.
  if (knownSkillNames != null) {
    const codeSpans: Array<{ from: number; to: number }> = [];
    for (const { from, to } of ranges) {
      tree.iterate({
        from,
        to,
        enter(node) {
          if (node.name === 'InlineCode' || node.name === 'FencedCode') {
            codeSpans.push({ from: node.from, to: node.to });
            return false;
          }
          return undefined;
        },
      });
    }
    const inCode = (a: number, b: number): boolean =>
      codeSpans.some((c) => a >= c.from && b <= c.to);
    for (const { from, to } of ranges) {
      const text = state.doc.sliceString(from, to);
      SKILL_REF_RE.lastIndex = 0;
      for (let m = SKILL_REF_RE.exec(text); m !== null; m = SKILL_REF_RE.exec(text)) {
        const slug = m[2] as string;
        if (!isSkillRefCandidate(slug)) continue;
        const start = from + (m.index ?? 0) + (m[1] as string).length;
        const end = start + slug.length + 1;
        if (inCode(start, end)) continue;
        decorations.push(
          Decoration.mark({
            class: knownSkillNames.has(slug) ? 'cm-skill-ref' : 'cm-skill-ref cm-skill-ref-missing',
            attributes: { 'data-skill-ref': slug },
          }).range(start, end),
        );
      }
    }
  }
  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'InlineCode') return;
        const raw = state.doc.sliceString(node.from, node.to);
        const open = raw.length - raw.replace(/^`+/, '').length;
        const close = raw.length - raw.replace(/`+$/, '').length;
        const inner = raw.slice(open, raw.length - close);
        const ref = /^\/([a-z0-9][a-z0-9-]{1,63})$/.exec(inner);
        const refSlug = ref?.[1];
        if (refSlug !== undefined && isSkillRefCandidate(refSlug) && knownSkillNames != null) {
          decorations.push(
            Decoration.mark({
              class: knownSkillNames.has(refSlug)
                ? 'cm-skill-ref'
                : 'cm-skill-ref cm-skill-ref-missing',
              attributes: { 'data-skill-ref': refSlug },
            }).range(node.from + open, node.to - close),
          );
          return false;
        }
        const m = BUNDLE_PATH_RE.exec(inner);
        if (!m) return;
        decorations.push(
          Decoration.mark({
            class: 'cm-skill-path-link',
            attributes: { 'data-skill-path': m[1] as string },
          }).range(node.from + open, node.to - close),
        );
        return false;
      },
    });
  }
  decorations.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(decorations);
}

export function createSkillPathLinksSourceExtension(docName: string): Extension {
  const target = skillDocTarget(docName);
  if (target === null) return [];
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildSkillPathDecorations(view.state, view.visibleRanges, namesAsSet());
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = buildSkillPathDecorations(
            update.view.state,
            update.view.visibleRanges,
            namesAsSet(),
          );
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
  const click = EditorView.domEventHandlers({
    mousedown(event) {
      // The path rides the decoration's data attribute, so a mark split across
      // highlight token boundaries still carries the full path on each piece.
      const refEl = (event.target as HTMLElement | null)?.closest?.('[data-skill-ref]');
      const slug = refEl instanceof HTMLElement ? refEl.dataset.skillRef : undefined;
      if (slug !== undefined) {
        event.preventDefault();
        const hit = getSkillNameSnapshot()?.get(slug);
        if (hit !== undefined) {
          window.location.hash = skillRefNavHashForHit(slug, hit);
        } else {
          // Name we cannot resolve: open the dock so the reader can look for it,
          // rather than route to the retired Skills home.
          requestSkillsDockExpanded();
        }
        return true;
      }
      const el = (event.target as HTMLElement | null)?.closest?.('.cm-skill-path-link');
      const path = el instanceof HTMLElement ? el.dataset.skillPath : undefined;
      if (path === undefined) return false;
      event.preventDefault();
      window.location.hash = skillBundlePathNavHash(target, docName, path);
      return true;
    },
  });
  return [plugin, click];
}

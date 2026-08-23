/**
 * Skill-doc path affordance — makes the ecosystem's native convention of
 * backticked bundle paths (`references/x.md`, `scripts/run.py`) clickable in
 * the WYSIWYG, display-only. Skills are authored for agents, which read inline
 * CODE paths fine; in the editor those spans were inert chips. This decorates
 * code-marked text whose full text is bundle-path-shaped and, on click, opens
 * the bundle file through the same scope-aware skill-file route the sidebar
 * file rows use — bytes are never touched (no schema change, no serialization
 * change), and resolution never walks the filesystem (so symlinked bundle
 * homes behave). Existence is NOT pre-checked; a click on a missing path lands
 * on the viewer's own not-found state.
 *
 * Active only when the doc IS a skill bundle doc (project in-place bundle doc,
 * or a `__skill__/<scope>/<name>` managed artifact). External (`__extskill__`)
 * docs are out of scope for now — their files open through a different scheme.
 */
import type { SkillScope } from '@inkeep/open-knowledge-core';
import {
  isSkillRefCandidate,
  parseManagedArtifactName,
  parseProjectSkillBundleDoc,
  RESERVED_PROJECT_SKILL_NAME,
  SKILL_REF_RE,
} from '@inkeep/open-knowledge-core';
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { requestSkillsDockExpanded } from '@/components/skills-dock-expanded-store';
import { hashFromDocName, hashFromSkillFile, hashFromSkillPreview } from '@/lib/doc-hash';
import { skillEntryFileLiveDocName, skillEntryLiveDocName } from '@/lib/managed-artifact-doc-name';
import { getSkillNameSnapshot, skillRefNavHashForHit } from '@/lib/skill-name-set';
import { resolveSkillRef } from '@/lib/skills-api';

/** Bundle-relative path shape: the two allowed roots, sane segments, no `..`,
 *  optional `./` prefix. Anchored over the WHOLE code span so prose that merely
 *  mentions a path mid-sentence inside a longer span stays inert. */
export const BUNDLE_PATH_RE = /^\.?\/?((?:references|scripts)(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+)$/;

// The `/skill-name` grammar lives in core (`constants/skills.ts`) — the server
// backlink index derives skill-ref graph edges from the SAME regex + stoplist,
// so what renders as a chip and what draws an edge can never drift. Re-exported
// for this module's consumers (source-mode mirror, tests).
export { isSkillRefCandidate, SKILL_REF_RE };

export function skillDocTarget(docName: string): { scope: SkillScope; name: string } | null {
  const inPlace = parseProjectSkillBundleDoc(docName);
  if (inPlace) return { scope: 'project', name: inPlace.name };
  const managed = parseManagedArtifactName(docName);
  if (managed?.kind === 'skill') return { scope: managed.scope, name: managed.name };
  return null;
}

/**
 * Where a clicked skill bundle-path link (`references/x.md`, `scripts/run.sh`)
 * navigates. An EDITABLE `.md`/`.mdx` reference of a non-built-in skill opens the
 * live editable doc — the SAME buffer the sidebar's `openFile` opens, so a link
 * and the sidebar agree. Scripts, binaries, and built-in
 * (`open-knowledge*`) skills keep the read-only skill-file viewer. `skillDocName`
 * is the SKILL doc the link was clicked in (a project skill's ext-less
 * `…/SKILL`); global scope ignores it.
 */
export function skillBundlePathNavHash(
  target: { scope: SkillScope; name: string },
  skillDocName: string,
  path: string,
): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const editable =
    (ext === 'md' || ext === 'mdx') && !target.name.startsWith(RESERVED_PROJECT_SKILL_NAME);
  if (!editable) return hashFromSkillFile({ ...target, path });
  // Reconstruct the entry shape `skillEntryFileLiveDocName` needs: a project
  // skill's doc name is the ext-less SKILL content doc; its `.md` form strips
  // back to the bundle dir. Global scope resolves by scope/name and ignores it.
  const skillPath = target.scope === 'project' ? `${skillDocName}.md` : '';
  return hashFromDocName(
    skillEntryFileLiveDocName({ scope: target.scope, name: target.name, path: skillPath }, path),
  );
}

function pathOfCodeSpan(node: PMNode): string | null {
  if (!node.isText || node.text === undefined) return null;
  if (!node.marks.some((m) => m.type.name === 'code')) return null;
  const m = BUNDLE_PATH_RE.exec(node.text);
  return m ? (m[1] as string) : null;
}

function buildDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  const known = getSkillNameSnapshot();
  doc.descendants((node, pos) => {
    const path = pathOfCodeSpan(node);
    if (path !== null) {
      decos.push(
        Decoration.inline(pos, pos + node.nodeSize, {
          class: 'ok-skill-path-link',
          'data-skill-path': path,
        }),
      );
      return undefined;
    }
    // `/skill-name` references. In PROSE, standalone tokens decorate; inside a
    // code mark ONLY a whole-span `/name` counts (skills conventionally write
    // the invocation as inline code — `/research` — while longer code spans
    // are literal commands/paths and stay inert).
    if (known !== null && node.isText && node.text !== undefined) {
      if (node.marks.some((m) => m.type.name === 'code')) {
        const whole = /^\/([a-z0-9][a-z0-9-]{1,63})$/.exec(node.text);
        const slug = whole?.[1];
        if (slug !== undefined && isSkillRefCandidate(slug)) {
          decos.push(
            Decoration.inline(pos, pos + node.nodeSize, {
              class: known.has(slug) ? 'ok-skill-ref' : 'ok-skill-ref ok-skill-ref-missing',
              'data-skill-ref': slug,
            }),
          );
        }
        return undefined;
      }
      SKILL_REF_RE.lastIndex = 0;
      for (let m = SKILL_REF_RE.exec(node.text); m !== null; m = SKILL_REF_RE.exec(node.text)) {
        const slug = m[2] as string;
        if (!isSkillRefCandidate(slug)) continue;
        const start = pos + (m.index ?? 0) + (m[1] as string).length;
        const installed = known.has(slug);
        decos.push(
          Decoration.inline(start, start + slug.length + 1, {
            class: installed ? 'ok-skill-ref' : 'ok-skill-ref ok-skill-ref-missing',
            'data-skill-ref': slug,
          }),
        );
      }
    }
    return undefined;
  });
  return DecorationSet.create(doc, decos);
}

const key = new PluginKey<DecorationSet>('okSkillPathLinks');

export const SkillPathLinks = Extension.create<{
  docName: string;
  /**
   * Context override for a clicked bundle-path chip (`references/…`,
   * `scripts/…`). When set and it returns `true`, it handles the click and the
   * default hash navigation is skipped — used by the in-preview file list, where
   * a chip should SWITCH the preview's selected file rather than navigate away to
   * a standalone skill-file view.
   */
  onBundlePathClick?: (path: string) => boolean;
}>({
  name: 'skillPathLinks',

  addOptions() {
    return { docName: '' };
  },

  addProseMirrorPlugins() {
    const docName = this.options.docName;
    const onBundlePathClick = this.options.onBundlePathClick;
    const target = skillDocTarget(docName);
    if (target === null) return [];
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => buildDecorations(state.doc),
          apply: (tr, decos) =>
            tr.docChanged ? buildDecorations(tr.doc) : decos.map(tr.mapping, tr.doc),
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
          handleClick(view, pos, event) {
            const el =
              event.target instanceof HTMLElement ? event.target.closest('[data-skill-ref]') : null;
            const slug = el instanceof HTMLElement ? el.dataset.skillRef : undefined;
            if (slug !== undefined) {
              const known = getSkillNameSnapshot();
              const hit = known?.get(slug);
              if (hit !== undefined) {
                window.location.hash = skillRefNavHashForHit(slug, hit);
              } else {
                // Not installed: resolve the reference by trusted-provenance
                // precedence (local / same-source sibling / same-publisher). A
                // trusted hit opens that skill or its preview; no trusted match
                // drops to the Skills hub for MANUAL search — never a fuzzy
                // auto-pick. Async fetch, then navigate (click is handled now).
                void resolveSkillRef({ ref: slug, scope: target.scope, from: target.name }).then(
                  (r) => {
                    if (r.ok && r.kind === 'local' && r.scope && r.name) {
                      // Use the resolver's REAL dir, matching the snapshot-hit
                      // branch above. Deriving from the name alone assumed the
                      // retired `.ok/skills` layout and opened a phantom tab.
                      window.location.hash = hashFromDocName(
                        skillEntryLiveDocName({
                          scope: r.scope,
                          name: r.name,
                          path: r.dir !== undefined ? `${r.dir}/SKILL.md` : '',
                        }),
                      );
                    } else if (r.ok && r.kind === 'import' && r.source && r.ref) {
                      window.location.hash = hashFromSkillPreview({
                        flavor: 'explore',
                        source: r.source,
                        name: r.ref,
                        subtitle: r.source,
                        level: target.scope,
                      });
                    } else {
                      // Nothing resolvable to open: reveal the sidebar dock,
                      // which replaced the Skills home.
                      requestSkillsDockExpanded();
                    }
                  },
                );
              }
              return true;
            }
            const $pos = view.state.doc.resolve(pos);
            const node = $pos.parent.maybeChild($pos.index());
            const path = node ? pathOfCodeSpan(node) : null;
            if (path === null) return false;
            // In-preview file list handles the click itself (switches the file);
            // everywhere else, navigate to the bundle file.
            if (onBundlePathClick?.(path) === true) return true;
            window.location.hash = skillBundlePathNavHash(target, docName, path);
            return true;
          },
        },
      }),
    ];
  },
});

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

export const BUNDLE_PATH_RE = /^\.?\/?((?:references|scripts)(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+)$/;

export { isSkillRefCandidate, SKILL_REF_RE };

export function skillDocTarget(docName: string): { scope: SkillScope; name: string } | null {
  const inPlace = parseProjectSkillBundleDoc(docName);
  if (inPlace) return { scope: 'project', name: inPlace.name };
  const managed = parseManagedArtifactName(docName);
  if (managed?.kind === 'skill') return { scope: managed.scope, name: managed.name };
  return null;
}

export function skillBundlePathNavHash(
  target: { scope: SkillScope; name: string },
  skillDocName: string,
  path: string,
): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const editable =
    (ext === 'md' || ext === 'mdx') && !target.name.startsWith(RESERVED_PROJECT_SKILL_NAME);
  if (!editable) return hashFromSkillFile({ ...target, path });
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
                void resolveSkillRef({ ref: slug, scope: target.scope, from: target.name }).then(
                  (r) => {
                    if (r.ok && r.kind === 'local' && r.scope && r.name) {
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
            if (onBundlePathClick?.(path) === true) return true;
            window.location.hash = skillBundlePathNavHash(target, docName, path);
            return true;
          },
        },
      }),
    ];
  },
});

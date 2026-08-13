import { describe, expect, test } from 'vitest';
import { filterGraphSkillNodes } from './graph-skill-filter';
import type { GraphData } from './graph-view-utils';

function doc(id: string, docName: string, managed = false) {
  return {
    kind: 'doc' as const,
    id,
    docName,
    anchor: null,
    label: docName,
    ...(managed ? { managed: true as const } : {}),
  };
}

/** A node the server flagged as one of OpenKnowledge's own bundles. */
function builtinDoc(id: string, docName: string) {
  return doc(id, docName, true);
}

function graph(
  nodes: ReturnType<typeof doc>[],
  links: Array<{ source: string; target: string }>,
): GraphData {
  return { nodes, links } as GraphData;
}

const BUILTIN_SKILL = '__skill__/global/open-knowledge-write-skill';
const BUILTIN_REF = '__skill__/global/open-knowledge-write-skill/references/patterns';
const USER_SKILL = '__skill__/global/my-notes';
const PROJECT_SKILL = '.claude/skills/team-conventions/SKILL';
const PACK_SKILL = '__skill__/global/open-knowledge-pack-worldbuilding';

const SHOW_FULLSCREEN = 'hide-builtins' as const;
const DOCKED = 'all' as const;
const HIDE_ALL = 'none' as const;

describe('filterGraphSkillNodes', () => {
  test('drops an unreferenced built-in bundle, keeping content and user skills', () => {
    const result = filterGraphSkillNodes(
      graph(
        [
          doc('a', 'notes/index'),
          builtinDoc('b', BUILTIN_SKILL),
          builtinDoc('c', BUILTIN_REF),
          doc('d', USER_SKILL),
        ],
        [{ source: 'b', target: 'c' }],
      ),
      SHOW_FULLSCREEN,
    );
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['a', 'd']);
    expect(result.links).toEqual([]);
  });

  test("a bundle's own structural edges do not make it self-referenced", () => {
    // The SKILL→reference edge crosses no bundle boundary. If it counted, no
    // built-in would ever be hidden and the default would be a no-op.
    const result = filterGraphSkillNodes(
      graph(
        [builtinDoc('b', BUILTIN_SKILL), builtinDoc('c', BUILTIN_REF)],
        [{ source: 'b', target: 'c' }],
      ),
      SHOW_FULLSCREEN,
    );
    expect(result.nodes).toEqual([]);
  });

  test('keeps a built-in that another skill links directly, with its references', () => {
    const result = filterGraphSkillNodes(
      graph(
        [doc('u', USER_SKILL), builtinDoc('b', BUILTIN_SKILL), builtinDoc('c', BUILTIN_REF)],
        [
          { source: 'u', target: 'b' },
          { source: 'b', target: 'c' },
        ],
      ),
      SHOW_FULLSCREEN,
    );
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['b', 'c', 'u']);
    expect(result.links).toHaveLength(2);
  });

  test('never hides a user skill whose name merely looks built-in', () => {
    // `open-knowledge-pack-*` installs are real user skills kept indefinitely. The
    // app classifies purely on the server's flag, so a name that resembles a
    // built-in is not enough to hide it.
    const result = filterGraphSkillNodes(graph([doc('p', PACK_SKILL)], []), SHOW_FULLSCREEN);
    expect(result.nodes.map((n) => n.id)).toEqual(['p']);
  });

  test('an unflagged node is never treated as built-in, whatever it is named', () => {
    const result = filterGraphSkillNodes(
      graph([doc('b', BUILTIN_SKILL), doc('c', BUILTIN_REF)], [{ source: 'b', target: 'c' }]),
      SHOW_FULLSCREEN,
    );
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['b', 'c']);
  });

  test('keeps project skills at the default setting', () => {
    const result = filterGraphSkillNodes(graph([doc('p', PROJECT_SKILL)], []), SHOW_FULLSCREEN);
    expect(result.nodes.map((n) => n.id)).toEqual(['p']);
  });

  test('showSkills=false drops every skill node including referenced built-ins', () => {
    const result = filterGraphSkillNodes(
      graph(
        [
          doc('a', 'notes/index'),
          doc('u', USER_SKILL),
          builtinDoc('b', BUILTIN_SKILL),
          doc('p', PROJECT_SKILL),
        ],
        [
          { source: 'u', target: 'b' },
          { source: 'a', target: 'p' },
        ],
      ),
      HIDE_ALL,
    );
    expect(result.nodes.map((n) => n.id)).toEqual(['a']);
    expect(result.links).toEqual([]);
  });

  test('the docked local graph keeps unreferenced built-ins', () => {
    const result = filterGraphSkillNodes(
      graph(
        [builtinDoc('b', BUILTIN_SKILL), builtinDoc('c', BUILTIN_REF)],
        [{ source: 'b', target: 'c' }],
      ),
      DOCKED,
    );
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['b', 'c']);
  });

  test('a graph with no skill nodes is returned untouched', () => {
    const input = graph([doc('a', 'notes/index')], []);
    expect(filterGraphSkillNodes(input, SHOW_FULLSCREEN)).toBe(input);
  });

  test('hides the project-scope built-in projection as well as the global ones', () => {
    const result = filterGraphSkillNodes(
      graph(
        [
          builtinDoc('g', '__skill__/global/open-knowledge-discovery'),
          builtinDoc('p', '.claude/skills/open-knowledge/SKILL'),
        ],
        [],
      ),
      SHOW_FULLSCREEN,
    );
    expect(result.nodes).toEqual([]);
  });

  test('keeps a built-in connected to a user skill regardless of authored direction', () => {
    // The link graph mirrors SKILL-to-SKILL refs, so edge direction cannot identify
    // which document authored the ref.
    const result = filterGraphSkillNodes(
      graph(
        [builtinDoc('b', BUILTIN_SKILL), doc('u', USER_SKILL)],
        [
          { source: 'b', target: 'u' },
          { source: 'u', target: 'b' },
        ],
      ),
      SHOW_FULLSCREEN,
    );
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['b', 'u']);
    expect(result.links).toHaveLength(2);
  });

  test('keeps built-ins connected across bundle boundaries visible', () => {
    const result = filterGraphSkillNodes(
      graph(
        [
          builtinDoc('b', BUILTIN_SKILL),
          builtinDoc('d', '__skill__/global/open-knowledge-discovery'),
        ],
        [
          { source: 'b', target: 'd' },
          { source: 'd', target: 'b' },
        ],
      ),
      SHOW_FULLSCREEN,
    );
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['b', 'd']);
  });
});

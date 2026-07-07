import { describe, expect, test } from 'bun:test';
import {
  managedArtifactDocNameFromContentTarget,
  parseGlobalSkillBundleDoc,
  parseProjectSkillBundleDoc,
  resolveSkillBundleWikiTarget,
} from './cc1.ts';

// The shared normalizer maps a content link target / doc name that points at a
// TEMPLATE file on disk to its managed-artifact doc name. It is the single
// source of truth used by both the client link resolver and the server link
// index, so a doc→template link resolves to the same identity in both places
// (click-through + backlinks). Project skills are NOT mapped here — they are
// real content docs (`.ok/skills/<name>/SKILL`) and resolve through the normal
// page index. These cases pin that contract.
describe('managedArtifactDocNameFromContentTarget', () => {
  test('does NOT rewrite project skill file paths — they are content docs', () => {
    // Project skills are indexed content now, not synthetic `__skill__/project`
    // docs, so a skill-file target falls through to normal page resolution.
    expect(managedArtifactDocNameFromContentTarget('.ok/skills/my-skill/SKILL.md')).toBeNull();
    expect(managedArtifactDocNameFromContentTarget('.ok/skills/my-skill/SKILL')).toBeNull();
    expect(managedArtifactDocNameFromContentTarget('.ok/skills/my-skill/SKILL.mdx')).toBeNull();
    expect(managedArtifactDocNameFromContentTarget('some/dir/.ok/skills/deep/SKILL.md')).toBeNull();
  });

  test('maps a root-level template to a folderless template doc name', () => {
    expect(managedArtifactDocNameFromContentTarget('.ok/templates/note.md')).toBe(
      '__template__/note',
    );
  });

  test('maps a template under a folder, preserving the folder segment', () => {
    expect(managedArtifactDocNameFromContentTarget('docs/.ok/templates/note.md')).toBe(
      '__template__/docs/note',
    );
    expect(managedArtifactDocNameFromContentTarget('docs/guides/.ok/templates/note')).toBe(
      '__template__/docs/guides/note',
    );
  });

  test('returns null for paths that are not skill/template files', () => {
    expect(managedArtifactDocNameFromContentTarget('docs/getting-started.md')).toBeNull();
    expect(managedArtifactDocNameFromContentTarget('.ok/skills/my-skill/NOTES.md')).toBeNull();
    expect(managedArtifactDocNameFromContentTarget('.ok/config.yml')).toBeNull();
    expect(managedArtifactDocNameFromContentTarget('readme')).toBeNull();
    expect(managedArtifactDocNameFromContentTarget('')).toBeNull();
  });
});

// A bundle-relative wiki-link inside a SKILL.md (`[[references/x]]`) is
// classified as a bare KB-wide doc name, so its inbound graph edge would land
// on a phantom content-root `references/x` instead of the sibling bundle ref.
// This helper remaps such targets to the bundle ref content doc. Shared by the
// server link index and client chip resolver so both surfaces agree.
describe('resolveSkillBundleWikiTarget', () => {
  const skill = '.ok/skills/demo/SKILL';

  test('resolves a references/ wiki-target to the sibling bundle ref', () => {
    expect(resolveSkillBundleWikiTarget('references/notes', skill)).toBe(
      '.ok/skills/demo/references/notes',
    );
    // Nested under references/.
    expect(resolveSkillBundleWikiTarget('references/sub/deep', skill)).toBe(
      '.ok/skills/demo/references/sub/deep',
    );
  });

  test('strips a markdown extension so [[references/x.md]] == [[references/x]]', () => {
    expect(resolveSkillBundleWikiTarget('references/notes.md', skill)).toBe(
      '.ok/skills/demo/references/notes',
    );
    expect(resolveSkillBundleWikiTarget('references/notes.MDX', skill)).toBe(
      '.ok/skills/demo/references/notes',
    );
  });

  test('resolves a scripts/ wiki-target too', () => {
    expect(resolveSkillBundleWikiTarget('scripts/run', skill)).toBe('.ok/skills/demo/scripts/run');
  });

  test('leaves bare names and non-bundle targets to KB-wide resolution', () => {
    // Bare name (no slash) keeps Obsidian-style page-set resolution.
    expect(resolveSkillBundleWikiTarget('notes', skill)).toBeNull();
    // Non-bundle first segment.
    expect(resolveSkillBundleWikiTarget('docs/intro', skill)).toBeNull();
    // references/ with no leaf segment.
    expect(resolveSkillBundleWikiTarget('references', skill)).toBeNull();
    expect(resolveSkillBundleWikiTarget('references/', skill)).toBeNull();
  });

  test('refuses traversal that would escape the skill dir', () => {
    expect(resolveSkillBundleWikiTarget('references/../../escape', skill)).toBeNull();
  });

  test('returns null when the source is not a project skill SKILL doc', () => {
    expect(resolveSkillBundleWikiTarget('references/notes', 'notes/index')).toBeNull();
    expect(
      resolveSkillBundleWikiTarget('references/notes', '.ok/skills/demo/references/x'),
    ).toBeNull();
    // Global skills are managed-artifact docs, not content SKILL docs.
    expect(resolveSkillBundleWikiTarget('references/notes', '__skill__/global/demo')).toBeNull();
  });
});

describe('parseProjectSkillBundleDoc', () => {
  test('parses a project SKILL doc', () => {
    expect(parseProjectSkillBundleDoc('.ok/skills/demo/SKILL')).toEqual({
      name: 'demo',
      kind: 'skill',
      rel: null,
    });
  });

  test('parses a project reference doc (flat and nested)', () => {
    expect(parseProjectSkillBundleDoc('.ok/skills/demo/references/notes')).toEqual({
      name: 'demo',
      kind: 'reference',
      rel: 'notes',
    });
    expect(parseProjectSkillBundleDoc('.ok/skills/demo/references/sub/deep')).toEqual({
      name: 'demo',
      kind: 'reference',
      rel: 'sub/deep',
    });
  });

  test('rejects non-bundle docs, scripts, global skills, and the bare skill dir', () => {
    // Regular docs — even ones that imitate the references shape outside the
    // skills root — never parse as bundle docs (scope containment).
    expect(parseProjectSkillBundleDoc('notes/index')).toBeNull();
    expect(parseProjectSkillBundleDoc('notes/references/x')).toBeNull();
    // scripts/** are not graph nodes.
    expect(parseProjectSkillBundleDoc('.ok/skills/demo/scripts/run')).toBeNull();
    // Global skills are managed-artifact docs, not content bundle docs.
    expect(parseProjectSkillBundleDoc('__skill__/global/demo')).toBeNull();
    // The skill dir itself / an empty references segment are not content docs.
    expect(parseProjectSkillBundleDoc('.ok/skills/demo')).toBeNull();
    expect(parseProjectSkillBundleDoc('.ok/skills/demo/references')).toBeNull();
    expect(parseProjectSkillBundleDoc('.ok/skills/demo/references/')).toBeNull();
  });
});

describe('parseGlobalSkillBundleDoc', () => {
  test('parses a global SKILL doc', () => {
    expect(parseGlobalSkillBundleDoc('__skill__/global/demo')).toEqual({
      name: 'demo',
      kind: 'skill',
      rel: null,
    });
  });

  test('parses a global reference doc (flat and nested)', () => {
    expect(parseGlobalSkillBundleDoc('__skill__/global/demo/references/notes')).toEqual({
      name: 'demo',
      kind: 'reference',
      rel: 'notes',
    });
    expect(parseGlobalSkillBundleDoc('__skill__/global/demo/references/sub/deep')).toEqual({
      name: 'demo',
      kind: 'reference',
      rel: 'sub/deep',
    });
  });

  test('rejects project bundle docs, scripts, the bare dir, and other scopes', () => {
    // Project skills are content docs, never global managed-artifact docs.
    expect(parseGlobalSkillBundleDoc('.ok/skills/demo/SKILL')).toBeNull();
    expect(parseGlobalSkillBundleDoc('.ok/skills/demo/references/notes')).toBeNull();
    // scripts/** are not graph nodes (mirrors the project predicate).
    expect(parseGlobalSkillBundleDoc('__skill__/global/demo/scripts/run')).toBeNull();
    // An empty references segment is not a content node.
    expect(parseGlobalSkillBundleDoc('__skill__/global/demo/references')).toBeNull();
    expect(parseGlobalSkillBundleDoc('__skill__/global/demo/references/')).toBeNull();
    // Only the global store qualifies — a non-`global` scope segment is rejected.
    expect(parseGlobalSkillBundleDoc('__skill__/project/demo')).toBeNull();
    expect(parseGlobalSkillBundleDoc('__skill__/project/demo/references/notes')).toBeNull();
    // Templates + ordinary docs never parse as a global skill bundle doc.
    expect(parseGlobalSkillBundleDoc('__template__/notes/daily')).toBeNull();
    expect(parseGlobalSkillBundleDoc('notes/index')).toBeNull();
  });
});

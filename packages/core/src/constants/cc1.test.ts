import { describe, expect, test } from 'vitest';
import {
  isManagedArtifactDocName,
  parseGlobalSkillBundleDoc,
  parseLegacyTemplateDocName,
  parseManagedArtifactName,
  parseProjectSkillBundleDoc,
  parseTemplateContentDocName,
  resolveSkillBundleWikiTarget,
  skillFileLiveDocName,
  skillLiveDocName,
  templateContentDocName,
} from './cc1.ts';

describe('parseManagedArtifactName — skill name/rel split (per-file editability)', () => {
  test('bare skill doc → rel is null (back-compat, unchanged)', () => {
    expect(parseManagedArtifactName('__skill__/global/demo')).toEqual({
      kind: 'skill',
      scope: 'global',
      name: 'demo',
      rel: null,
      host: null,
    });
    expect(parseManagedArtifactName('__skill__/project/demo')).toEqual({
      kind: 'skill',
      scope: 'project',
      name: 'demo',
      rel: null,
      host: null,
    });
  });

  test('per-file skill doc → name is the first segment, rel is the remainder', () => {
    expect(parseManagedArtifactName('__skill__/global/demo/references/patterns')).toEqual({
      kind: 'skill',
      scope: 'global',
      name: 'demo',
      rel: 'references/patterns',
      host: null,
    });
    expect(parseManagedArtifactName('__skill__/global/demo/references/sub/deep')).toEqual({
      kind: 'skill',
      scope: 'global',
      name: 'demo',
      rel: 'references/sub/deep',
      host: null,
    });
  });

  test('skillFileLiveDocName round-trips through parseManagedArtifactName (global)', () => {
    const doc = skillFileLiveDocName('global', 'demo', 'references/patterns.md');
    expect(doc).toBe('__skill__/global/demo/references/patterns'); // ext-less
    expect(parseManagedArtifactName(doc)).toEqual({
      kind: 'skill',
      scope: 'global',
      name: 'demo',
      rel: 'references/patterns',
      host: null,
    });
  });

  test('skillFileLiveDocName(project) is a content doc, not a managed-artifact name', () => {
    expect(skillFileLiveDocName('project', 'demo', 'references/patterns.md')).toBe(
      '.ok/skills/demo/references/patterns',
    );
    // The bare SKILL doc name is unchanged.
    expect(skillLiveDocName('global', 'demo')).toBe('__skill__/global/demo');
  });
});

// The shared normalizer maps a content link target / doc name that points at a
// TEMPLATE file on disk to its managed-artifact doc name. It is the single
// source of truth used by both the client link resolver and the server link
// index, so a doc→template link resolves to the same identity in both places
// (click-through + backlinks). Project skills are NOT mapped here — they are
// real content docs (`.ok/skills/<name>/SKILL`) and resolve through the normal
// page index. These cases pin that contract.
describe('parseManagedArtifactName — __template__ tombstone', () => {
  test('returns null for a synthetic template name (no live artifact resolves)', () => {
    // The template parse arm is gone: a stale `__template__/…` name must NOT
    // resolve to an artifact, so it can never reach the content branch and mint
    // a literal `__template__/…` file. Templates are content docs.
    expect(parseManagedArtifactName('__template__/note')).toBeNull();
    expect(parseManagedArtifactName('__template__/docs/note')).toBeNull();
    expect(parseManagedArtifactName('__template__/docs/guides/note')).toBeNull();
  });

  test('but the prefix still classifies as a managed-artifact name (tombstone)', () => {
    // The reserved-name gates (tree exclusion, create-page refusal, persistence
    // quarantine, the navigation redirect) all key off this classifier, so the
    // prefix survives even though the parser refuses it.
    expect(isManagedArtifactDocName('__template__/note')).toBe(true);
    expect(isManagedArtifactDocName('__template__/docs/note')).toBe(true);
  });

  test('a template content name is NOT a managed-artifact name', () => {
    expect(parseManagedArtifactName('docs/.ok/templates/note')).toBeNull();
    expect(isManagedArtifactDocName('docs/.ok/templates/note')).toBe(false);
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

  test('resolves from a REFERENCE doc, an IN-PLACE bundle, a GLOBAL artifact, and an extskill', () => {
    // Bundle paths are authored bundle-root-relative regardless of which bundle
    // doc mentions them — a reference doc resolves against its own bundle root.
    expect(
      resolveSkillBundleWikiTarget('references/sibling', '.ok/skills/demo/references/notes'),
    ).toBe('.ok/skills/demo/references/sibling');
    expect(
      resolveSkillBundleWikiTarget('references/notes', '.agents/skills/demo/references/deep/x'),
    ).toBe('.agents/skills/demo/references/notes');
    expect(resolveSkillBundleWikiTarget('scripts/run', '__skill__/global/demo')).toBe(
      '__skill__/global/demo/scripts/run',
    );
    expect(
      resolveSkillBundleWikiTarget('references/notes', '__skill__/global/demo/references/other'),
    ).toBe('__skill__/global/demo/references/notes');
    expect(resolveSkillBundleWikiTarget('references/notes', '__extskill__/demo')).toBe(
      '__extskill__/demo/references/notes',
    );
    expect(
      resolveSkillBundleWikiTarget('references/notes', '__extskill__/demo/references/other'),
    ).toBe('__extskill__/demo/references/notes');
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

  test('returns null when the source is not a bundle doc at all', () => {
    expect(resolveSkillBundleWikiTarget('references/notes', 'notes/index')).toBeNull();
    expect(resolveSkillBundleWikiTarget('references/notes', 'docs/guide')).toBeNull();
    // A template artifact is managed but not a skill bundle.
    expect(resolveSkillBundleWikiTarget('references/notes', '__template__/x/y')).toBeNull();
  });

  test('resolves for an IN-PLACE editor-dir skill too (.claude/.codex/.github/skills)', () => {
    expect(resolveSkillBundleWikiTarget('references/notes', '.claude/skills/demo/SKILL')).toBe(
      '.claude/skills/demo/references/notes',
    );
    expect(resolveSkillBundleWikiTarget('references/x', '.codex/skills/demo/SKILL')).toBe(
      '.codex/skills/demo/references/x',
    );
    expect(resolveSkillBundleWikiTarget('references/y', '.github/skills/demo/SKILL')).toBe(
      '.github/skills/demo/references/y',
    );
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

  test('parses an IN-PLACE editor-dir skill (SKILL + references), same shape as .ok/skills', () => {
    expect(parseProjectSkillBundleDoc('.claude/skills/demo/SKILL')).toEqual({
      name: 'demo',
      kind: 'skill',
      rel: null,
    });
    expect(parseProjectSkillBundleDoc('.codex/skills/demo/references/notes')).toEqual({
      name: 'demo',
      kind: 'reference',
      rel: 'notes',
    });
    // scripts/** still not graph nodes, in any root.
    expect(parseProjectSkillBundleDoc('.claude/skills/demo/scripts/run')).toBeNull();
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
      host: null,
    });
  });

  test('parses a global reference doc (flat and nested)', () => {
    expect(parseGlobalSkillBundleDoc('__skill__/global/demo/references/notes')).toEqual({
      name: 'demo',
      kind: 'reference',
      rel: 'notes',
      host: null,
    });
    expect(parseGlobalSkillBundleDoc('__skill__/global/demo/references/sub/deep')).toEqual({
      name: 'demo',
      kind: 'reference',
      rel: 'sub/deep',
      host: null,
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

// A template's live doc name is its content-relative path. This builder + shape
// parser + legacy parser are the single identity every surface shares; these
// cases pin the raw (unencoded) content shape, the single-leaf-only rule, and
// the percent-decoding the legacy synthetic-name reader must preserve.
describe('templateContentDocName', () => {
  test('builds a root template content doc name (ext-less, raw)', () => {
    expect(templateContentDocName('', 'daily')).toBe('.ok/templates/daily');
  });

  test('builds a single-level folder template content doc name', () => {
    expect(templateContentDocName('docs', 'daily')).toBe('docs/.ok/templates/daily');
  });

  test('builds a nested-folder template content doc name', () => {
    expect(templateContentDocName('a/b', 'daily')).toBe('a/b/.ok/templates/daily');
  });

  test('normalizes leading/trailing slashes on the folder', () => {
    expect(templateContentDocName('/docs/', 'daily')).toBe('docs/.ok/templates/daily');
  });

  test('keeps a spaced folder RAW — no percent-encoding', () => {
    expect(templateContentDocName('My Notes', 'daily')).toBe('My Notes/.ok/templates/daily');
  });
});

describe('parseTemplateContentDocName', () => {
  test('parses a root template leaf', () => {
    expect(parseTemplateContentDocName('.ok/templates/daily')).toEqual({
      folder: '',
      name: 'daily',
    });
  });

  test('parses a template leaf under a folder, preserving the folder segment', () => {
    expect(parseTemplateContentDocName('docs/.ok/templates/daily')).toEqual({
      folder: 'docs',
      name: 'daily',
    });
    expect(parseTemplateContentDocName('a/b/.ok/templates/daily')).toEqual({
      folder: 'a/b',
      name: 'daily',
    });
  });

  test('returns null for a subdirectory under .ok/templates — templates are single leaves', () => {
    expect(parseTemplateContentDocName('.ok/templates/sub/daily')).toBeNull();
    expect(parseTemplateContentDocName('docs/.ok/templates/sub/daily')).toBeNull();
  });

  test('returns null for a non-template .ok path', () => {
    expect(parseTemplateContentDocName('.ok/skills/demo/SKILL')).toBeNull();
    expect(parseTemplateContentDocName('.ok/config.yml')).toBeNull();
  });

  test('returns null for an ordinary content doc name', () => {
    expect(parseTemplateContentDocName('docs/getting-started')).toBeNull();
    expect(parseTemplateContentDocName('readme')).toBeNull();
    expect(parseTemplateContentDocName('')).toBeNull();
  });

  test('strips a `.md` suffix but no other extension — a template IS a `.md` leaf', () => {
    // Mirrors `isTemplateContentFile`, which admits only `.md` under
    // `.ok/templates/`: the two halves of the grammar must agree about what a
    // template is. A `.mdx` (or any other) suffix is not the template file
    // extension, so it stays part of the leaf like any odd character would.
    expect(parseTemplateContentDocName('.ok/templates/daily.md')).toEqual({
      folder: '',
      name: 'daily',
    });
    expect(parseTemplateContentDocName('docs/.ok/templates/daily.mdx')).toEqual({
      folder: 'docs',
      name: 'daily.mdx',
    });
  });

  test('parses by SHAPE only — a name that would fail the template-name grammar still parses', () => {
    // Name validation lives at the HTTP write layer, not in the doc-name grammar,
    // so the shape parser must not reject on the leaf's characters.
    expect(parseTemplateContentDocName('.ok/templates/Has Spaces')).toEqual({
      folder: '',
      name: 'Has Spaces',
    });
    expect(parseTemplateContentDocName('docs/.ok/templates/UPPER_case!')).toEqual({
      folder: 'docs',
      name: 'UPPER_case!',
    });
  });
});

describe('parseLegacyTemplateDocName', () => {
  test('parses a stale synthetic root template name', () => {
    expect(parseLegacyTemplateDocName('__template__/daily')).toEqual({ folder: '', name: 'daily' });
  });

  test('parses a stale synthetic name under a folder (flat and nested)', () => {
    expect(parseLegacyTemplateDocName('__template__/docs/daily')).toEqual({
      folder: 'docs',
      name: 'daily',
    });
    expect(parseLegacyTemplateDocName('__template__/a/b/daily')).toEqual({
      folder: 'a/b',
      name: 'daily',
    });
  });

  test('percent-DECODES each segment so an encoded stale name maps to the raw folder/name', () => {
    expect(parseLegacyTemplateDocName('__template__/My%20Notes/daily')).toEqual({
      folder: 'My Notes',
      name: 'daily',
    });
  });

  test('returns null for a content-shaped name and other non-synthetic names', () => {
    expect(parseLegacyTemplateDocName('docs/.ok/templates/daily')).toBeNull();
    expect(parseLegacyTemplateDocName('docs/getting-started')).toBeNull();
    expect(parseLegacyTemplateDocName('__skill__/global/demo')).toBeNull();
    expect(parseLegacyTemplateDocName('__template__/')).toBeNull();
    expect(parseLegacyTemplateDocName('')).toBeNull();
  });
});

describe('template content name round-trips (build → parse)', () => {
  test.each([
    { label: 'root', folder: '', name: 'daily' },
    { label: 'single-level folder', folder: 'docs', name: 'daily' },
    { label: 'nested folder', folder: 'a/b', name: 'daily' },
    { label: 'spaced folder', folder: 'My Notes', name: 'daily' },
  ])('round-trips a $label', ({ folder, name }) => {
    expect(parseTemplateContentDocName(templateContentDocName(folder, name))).toEqual({
      folder,
      name,
    });
  });
});

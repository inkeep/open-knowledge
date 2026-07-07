import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTemplateFile } from '@inkeep/open-knowledge-core';
import {
  extractMarkdownLinksFromMarkdown,
  extractWikiLinksFromMarkdown,
} from '../backlink-index.ts';
import {
  buildStarterFolderFrontmatterYaml,
  listStarterPacks,
  OKF_RESERVED_FILENAMES,
  STARTER_FOLDER_FRONTMATTER_FILENAME,
  STARTER_PACK_IDS,
  STARTER_PACKS,
} from './starter.ts';

const KNOWLEDGE_BASE_PACK = STARTER_PACKS['knowledge-base'];
const STARTER_FOLDERS = KNOWLEDGE_BASE_PACK.folders;
const STARTER_TEMPLATES = KNOWLEDGE_BASE_PACK.templates;
const LOG_MD_TEMPLATE = KNOWLEDGE_BASE_PACK.rootFiles?.['log.md'];
if (!LOG_MD_TEMPLATE) throw new Error('knowledge-base pack is missing log.md');
const ENTITY_VAULT_PACK = STARTER_PACKS['entity-vault'];
const CODEBASE_WIKI_PACK = STARTER_PACKS['codebase-wiki'];

// The "document body" a new doc receives — single-block templates carry the
// identity under `template:` and the doc-frontmatter as top-level keys, so the
// starter content is the doc-frontmatter block + markdown (identity stripped).
// `parseTemplateFile` normalizes legacy two-block templates the same way.
function stripTemplateMetadata(body: string): string {
  return parseTemplateFile(body).starterContent;
}

function documentFrontmatter(body: string): string {
  const documentBody = stripTemplateMetadata(body);
  const match = /^---\n([\s\S]*?)\n---/.exec(documentBody);
  if (!match?.[1]) throw new Error('template missing document frontmatter');
  return match[1];
}

describe('STARTER_FOLDERS — Karpathy three-layer starter pack', () => {
  test('ships exactly three starter folders in Karpathy-layer order', () => {
    expect(STARTER_FOLDERS).toHaveLength(3);
    expect(STARTER_FOLDERS.map((f) => f.path)).toEqual([
      'external-sources',
      'research',
      'articles',
    ]);
  });

  test('each entry has all required fields and non-empty values', () => {
    for (const folder of STARTER_FOLDERS) {
      expect(folder.path).toMatch(/^[a-z][a-z-]*$/);
      expect(folder.title.length).toBeGreaterThan(0);
      expect(folder.description.length).toBeGreaterThan(20);
      expect(folder.tags.length).toBeGreaterThan(0);
      // starterTemplate must reference a registered template body.
      expect(STARTER_TEMPLATES[folder.starterTemplate]).toBeDefined();
    }
  });

  test('external-sources description references save-verbatim + ingest + immutability + traceability', () => {
    const entry = STARTER_FOLDERS.find((f) => f.path === 'external-sources');
    expect(entry).toBeDefined();
    expect(entry?.description).toContain('saved verbatim');
    expect(entry?.description).toContain('Immutable');
    expect(entry?.description).toContain('ingest');
    expect(entry?.description).toContain('research/');
    expect(entry?.tags).toEqual(['source', 'immutable', 'layer-ingest']);
    expect(entry?.starterTemplate).toBe('clip');
  });

  test('research description references research tool + provisional status + sources + grounding rule', () => {
    const entry = STARTER_FOLDERS.find((f) => f.path === 'research');
    expect(entry).toBeDefined();
    expect(entry?.description).toContain('Provisional analysis');
    expect(entry?.description).toContain('external-sources');
    expect(entry?.description).toContain('status: provisional');
    expect(entry?.description).toContain('consolidate');
    expect(entry?.description.toLowerCase()).toMatch(/cite/);
    expect(entry?.tags).toEqual(['research', 'provisional', 'layer-research']);
    expect(entry?.starterTemplate).toBe('research-log');
  });

  test('articles description references consolidate + canonical status + supersedes chain + traceable evidence', () => {
    const entry = STARTER_FOLDERS.find((f) => f.path === 'articles');
    expect(entry).toBeDefined();
    expect(entry?.description).toContain('Canonical knowledge');
    expect(entry?.description).toContain('source of truth');
    expect(entry?.description).toContain('supersedes:');
    expect(entry?.description).toContain('research/');
    expect(entry?.tags).toEqual(['article', 'canonical', 'layer-consolidate']);
    expect(entry?.starterTemplate).toBe('article');
  });
});

describe('STARTER_TEMPLATES', () => {
  test('ships exactly the three starter templates', () => {
    expect(Object.keys(STARTER_TEMPLATES).sort()).toEqual(['article', 'clip', 'research-log']);
  });

  test('each template has a non-empty body with frontmatter + title + tags', () => {
    for (const [name, body] of Object.entries(STARTER_TEMPLATES)) {
      expect(body.length).toBeGreaterThan(50);
      expect(body.startsWith('---\n')).toBe(true);
      expect(body).toContain('title:');
      expect(body).toContain('tags:');
      // Sanity: name appears in either the body or frontmatter description.
      expect(body.toLowerCase()).toContain(name.replace('-', ' ').slice(0, 3));
    }
  });

  test('templates use only the v1 substitution allowlist tokens ({{date}} / {{user}})', () => {
    const ALLOWED = new Set(['date', 'user']);
    for (const [name, body] of Object.entries(STARTER_TEMPLATES)) {
      const tokens = [...body.matchAll(/\{\{([^{}\n]+?)\}\}/g)].map((m) => (m[1] ?? '').trim());
      for (const token of tokens) {
        expect(
          ALLOWED.has(token),
          `Template "${name}" uses unknown token "{{${token}}}" — only {{date}} and {{user}} are allowed in v1.`,
        ).toBe(true);
      }
    }
  });
});

describe('LOG_MD_TEMPLATE', () => {
  test('has frontmatter with title and description', () => {
    expect(LOG_MD_TEMPLATE).toContain('---');
    expect(LOG_MD_TEMPLATE).toContain('title: Work Log');
    expect(LOG_MD_TEMPLATE).toContain('description:');
  });

  test('has H1 heading', () => {
    expect(LOG_MD_TEMPLATE).toContain('# Work Log');
  });

  test('is slim — log discipline lives in the pack skill, not in the log body', () => {
    // The verbose "What to log" list + example-shape comment moved to the
    // knowledge-base pack skill so the file a user sees stays clean.
    expect(LOG_MD_TEMPLATE).not.toContain('<!-- Example entry shape:');
    expect(LOG_MD_TEMPLATE).not.toContain('What to log:');
    expect(LOG_MD_TEMPLATE).toContain('knowledge-base skill');
  });
});

describe('STARTER_FOLDER_FRONTMATTER_FILENAME', () => {
  test('is the canonical literal expected by the cascade resolver', () => {
    expect(STARTER_FOLDER_FRONTMATTER_FILENAME).toBe('frontmatter.yml');
  });
});

describe('STARTER_PACKS — all packs structural validation', () => {
  test('STARTER_PACK_IDS contains exactly the 8 expected packs (pinned to detect silent additions/deletions)', () => {
    // Pinned count + name set — drift surfaces in the test diff rather than
    // silently passing with a smaller loop in downstream structural tests.
    expect(STARTER_PACK_IDS.length).toBe(8);
    expect([...STARTER_PACK_IDS].sort()).toEqual([
      'codebase-wiki',
      'entity-vault',
      'knowledge-base',
      'okf',
      'plain-notes',
      'software-lifecycle',
      'worldbuilding',
      'writing-pipeline',
    ]);
    for (const id of STARTER_PACK_IDS) {
      expect(STARTER_PACKS[id]).toBeDefined();
      expect(STARTER_PACKS[id]?.id).toBe(id);
    }
  });

  test('every pack has non-empty name + description', () => {
    for (const pack of Object.values(STARTER_PACKS)) {
      expect(pack.name.length).toBeGreaterThan(0);
      expect(pack.description.length).toBeGreaterThan(10);
    }
  });

  // The empty-state canvas + SeedDialog picker render each description in a
  // card that line-clamps to 2 lines (PackCardGrid). At that card's ~32
  // chars/line, two lines hold ~64 chars; past that the clamp truncates with
  // an ellipsis. line-clamp-2 is the hard visual guarantee — this budget is
  // the authoring guardrail that keeps source descriptions short enough that
  // the clamp never actually has to truncate. Keep in sync if the card's
  // clamp/width changes.
  const MAX_PACK_DESCRIPTION_LENGTH = 64;
  test(`every pack description fits the picker card's 2-line budget (<= ${MAX_PACK_DESCRIPTION_LENGTH} chars)`, () => {
    const tooLong = Object.values(STARTER_PACKS)
      .filter((pack) => pack.description.length > MAX_PACK_DESCRIPTION_LENGTH)
      .map((pack) => `${pack.id} (${pack.description.length} chars)`);
    expect(tooLong).toEqual([]);
  });

  test('every folder starterTemplate + extraTemplates resolves to a body in pack.templates', () => {
    for (const pack of Object.values(STARTER_PACKS)) {
      for (const folder of pack.folders) {
        expect(
          pack.templates[folder.starterTemplate],
          `starterTemplate "${folder.starterTemplate}" in folder "${folder.path}" of pack "${pack.id}" has no body`,
        ).toBeDefined();
        for (const extra of folder.extraTemplates ?? []) {
          expect(
            pack.templates[extra],
            `extraTemplate "${extra}" in folder "${folder.path}" of pack "${pack.id}" has no body`,
          ).toBeDefined();
        }
      }
    }
  });

  test('every template body across every pack uses only v1 substitution tokens', () => {
    const ALLOWED = new Set(['date', 'user']);
    for (const pack of Object.values(STARTER_PACKS)) {
      for (const [name, body] of Object.entries(pack.templates)) {
        const tokens = [...body.matchAll(/\{\{([^{}\n]+?)\}\}/g)].map((m) => (m[1] ?? '').trim());
        for (const token of tokens) {
          expect(
            ALLOWED.has(token),
            `Pack "${pack.id}" template "${name}" uses unknown token "{{${token}}}" — only {{date}} and {{user}} are allowed in v1.`,
          ).toBe(true);
        }
      }
    }
  });

  test('every folder path uses kebab-case per segment (nested paths allowed, e.g. wiki/architecture)', () => {
    // Folder paths may nest (the `codebase-wiki` pack uses `wiki/architecture`,
    // … so it scaffolds under `wiki/` without `--root`). Each
    // slash-separated segment must still be kebab-case (the scaffolder's
    // path-safety layer rejects `..`, absolute, and escaping paths separately).
    for (const pack of Object.values(STARTER_PACKS)) {
      for (const folder of pack.folders) {
        for (const segment of folder.path.split('/')) {
          expect(
            segment,
            `folder "${folder.path}" in pack "${pack.id}" has a non-kebab segment "${segment}"`,
          ).toMatch(/^[a-z][a-z0-9-]*$/);
        }
      }
    }
  });

  test('every template name uses filename-safe characters (alphanumeric + hyphens + underscores, matches the cascade resolver regex)', () => {
    // Matches the filename validator in `templates-write.ts` — broader than
    // strict kebab-case so template authors can use snake_case if they want.
    // Folder paths are kebab-case-only.
    for (const pack of Object.values(STARTER_PACKS)) {
      for (const name of Object.keys(pack.templates)) {
        expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    }
  });

  test('every template body has frontmatter with a non-empty title', () => {
    for (const pack of Object.values(STARTER_PACKS)) {
      for (const [name, body] of Object.entries(pack.templates)) {
        expect(body.startsWith('---\n')).toBe(true);
        expect(body, `Pack "${pack.id}" template "${name}" missing title:`).toContain('title:');
      }
    }
  });

  test('every template body has a description: frontmatter line (load-bearing customer convention)', () => {
    // description: is the one-line surface shown in folder listings, the picker
    // UI's per-doc preview, and search results. The cascade resolver leans on
    // it. Every template across every pack ships with one — adding a template
    // without description: produces docs that read inconsistent next to the
    // rest of the vault. Hard-fail in CI rather than relying on review catch.
    for (const pack of Object.values(STARTER_PACKS)) {
      for (const [name, body] of Object.entries(pack.templates)) {
        const { description } = parseTemplateFile(body).identity;
        expect(
          typeof description === 'string' && description.trim().length > 0,
          `Pack "${pack.id}" template "${name}" missing template.description`,
        ).toBe(true);
      }
    }
  });

  test('no template body is registered without being referenced from some folder', () => {
    // Catches the inverse drift: orphaned template bodies that nothing scaffolds.
    for (const pack of Object.values(STARTER_PACKS)) {
      const referenced = new Set<string>();
      for (const folder of pack.folders) {
        referenced.add(folder.starterTemplate);
        for (const extra of folder.extraTemplates ?? []) referenced.add(extra);
      }
      for (const templateName of Object.keys(pack.templates)) {
        expect(
          referenced.has(templateName),
          `Pack "${pack.id}" template "${templateName}" is registered but referenced by no folder.`,
        ).toBe(true);
      }
    }
  });

  test('defaultSubfolder when set uses kebab-case (matches rootDir normalization expectations)', () => {
    for (const pack of Object.values(STARTER_PACKS)) {
      if (pack.defaultSubfolder !== undefined) {
        expect(
          pack.defaultSubfolder,
          `Pack "${pack.id}" defaultSubfolder "${pack.defaultSubfolder}" should be kebab-case.`,
        ).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    }
  });

  // OKF reserved files (lowercase `index.md` / `log.md`) are frontmatter-free
  // BY REQUIREMENT — any frontmatter on a reserved file is an OKF §9 rule-3
  // violation (see the okf pack + okf-conformance.test.ts). They are the sole
  // exemption to the "every rootFile carries a title" convention; every other
  // rootFile across every pack still must.
  const OKF_RESERVED_ROOTFILES = new Set(OKF_RESERVED_FILENAMES);

  test('every non-reserved rootFile body has frontmatter with a non-empty title', () => {
    for (const pack of Object.values(STARTER_PACKS)) {
      for (const [filename, body] of Object.entries(pack.rootFiles ?? {})) {
        if (pack.id === 'okf' && OKF_RESERVED_ROOTFILES.has(filename)) continue;
        expect(
          body.startsWith('---\n'),
          `Pack "${pack.id}" rootFile "${filename}" missing frontmatter`,
        ).toBe(true);
        expect(body, `Pack "${pack.id}" rootFile "${filename}" missing title:`).toContain('title:');
      }
    }
  });

  test('every rootFile body uses only v1 substitution tokens', () => {
    const ALLOWED = new Set(['date', 'user']);
    for (const pack of Object.values(STARTER_PACKS)) {
      for (const [filename, body] of Object.entries(pack.rootFiles ?? {})) {
        const tokens = [...body.matchAll(/\{\{([^{}\n]+?)\}\}/g)].map((m) => (m[1] ?? '').trim());
        for (const token of tokens) {
          expect(
            ALLOWED.has(token),
            `Pack "${pack.id}" rootFile "${filename}" uses unknown token "{{${token}}}" — only {{date}} and {{user}} are allowed in v1.`,
          ).toBe(true);
        }
      }
    }
  });

  test('every rootFile key is a safe relative path (forward-slash nesting allowed, no escape)', () => {
    // rootFiles keys are usually bare filenames (`log.md`), but may carry a
    // forward-slash folder prefix so the file lands in a pack subfolder
    // (`codebase-wiki` ships `wiki/OVERVIEW.md` + `wiki/log.md`). The
    // apply path runs every entry through `assertEntryPathInProject` for
    // containment; this static guard keeps the registry keys themselves clean:
    // relative, no backslash, no `..`, no absolute, every segment non-empty and
    // not a dotfile.
    for (const pack of Object.values(STARTER_PACKS)) {
      for (const filename of Object.keys(pack.rootFiles ?? {})) {
        expect(filename.length, `Pack "${pack.id}" has an empty rootFile key`).toBeGreaterThan(0);
        expect(
          filename,
          `Pack "${pack.id}" rootFile "${filename}" contains backslash`,
        ).not.toContain('\\');
        expect(filename, `Pack "${pack.id}" rootFile "${filename}" is absolute`).not.toMatch(/^\//);
        for (const segment of filename.split('/')) {
          expect(
            segment.length,
            `Pack "${pack.id}" rootFile "${filename}" has an empty path segment`,
          ).toBeGreaterThan(0);
          expect(segment, `Pack "${pack.id}" rootFile "${filename}" has a '..' segment`).not.toBe(
            '..',
          );
          expect(
            segment,
            `Pack "${pack.id}" rootFile "${filename}" has a dotfile segment "${segment}"`,
          ).not.toMatch(/^\./);
        }
      }
    }
  });
});

describe('Entity vault pack — GBrain-compatible Markdown shape', () => {
  test('uses entity-vault as the only canonical pack id (no gbrain alias)', () => {
    expect(ENTITY_VAULT_PACK.id).toBe('entity-vault');
    expect((STARTER_PACKS as Record<string, unknown>).gbrain).toBeUndefined();
  });

  test('display name is the plain-language "Personal CRM"; copy stays novice-friendly', () => {
    // GBrain-compatibility lives in the pack's file shape (id + templates +
    // frontmatter), NOT the display name — the card title is plain-spoken like
    // every other pack, and the description carries no insider mechanics.
    expect(ENTITY_VAULT_PACK.name).toBe('Personal CRM');
    expect(ENTITY_VAULT_PACK.description).toContain('people, companies, and meetings');
    // No replacement-engine claim — OK is the editor, not a GBrain replacement.
    expect(ENTITY_VAULT_PACK.description).not.toMatch(/replaces?\s+gbrain/i);
  });

  test('entity templates keep title + type in the generated document frontmatter', () => {
    const expectedTypes: Record<string, string> = {
      person: 'person',
      company: 'company',
      concept: 'concept',
      meeting: 'meeting',
      original: 'original',
      transcript: 'transcript',
    };
    for (const [templateName, expectedType] of Object.entries(expectedTypes)) {
      const body = ENTITY_VAULT_PACK.templates[templateName];
      expect(body, `missing ${templateName} template`).toBeDefined();
      const fm = documentFrontmatter(body ?? '');
      expect(fm, `${templateName} generated doc frontmatter missing title`).toMatch(
        /^title:\s*\S/m,
      );
      expect(fm, `${templateName} generated doc frontmatter missing type`).toContain(
        `type: ${expectedType}`,
      );
    }
  });

  test('compiled-truth dossier templates use the explicit timeline separator and parseable dated bullets', () => {
    for (const templateName of ['person', 'company', 'concept']) {
      const documentBody = stripTemplateMetadata(ENTITY_VAULT_PACK.templates[templateName] ?? '');
      expect(documentBody).toContain('--- timeline ---');
      expect(documentBody).toMatch(/^- \*\*\{\{date\}\}\*\* \| source \| @\{\{user\}\} — .+/m);
      expect(documentBody).not.toMatch(/\{\{date\}\}: First entry/);
    }
  });

  test('template guidance prefers path-qualified wikilinks where entity identity matters', () => {
    expect(ENTITY_VAULT_PACK.templates.person).toContain('[[companies/acme|Acme]]');
    expect(ENTITY_VAULT_PACK.templates.company).toContain('[[people/jane-founder|Jane Founder]]');
    expect(ENTITY_VAULT_PACK.templates.meeting).toContain('[[companies/jane-co|Jane Co]]');
    expect(ENTITY_VAULT_PACK.templates.meeting).toContain(
      '[[concepts/agent-runtime-observability|agent-runtime observability]]',
    );
  });
});

describe('Codebase wiki pack — nested wiki/ layout', () => {
  test('scaffolds the five sections nested under wiki/, in reading order', () => {
    expect(CODEBASE_WIKI_PACK.id).toBe('codebase-wiki');
    expect(CODEBASE_WIKI_PACK.folders.map((f) => f.path)).toEqual([
      'wiki/architecture',
      'wiki/modules',
      'wiki/flows',
      'wiki/concepts',
      'wiki/guides',
    ]);
  });

  test('every folder path nests under wiki/ so it scaffolds without --root', () => {
    for (const folder of CODEBASE_WIKI_PACK.folders) {
      expect(
        folder.path.startsWith('wiki/'),
        `folder "${folder.path}" should nest under wiki/`,
      ).toBe(true);
    }
  });

  test('no defaultSubfolder — the nested paths already place everything under wiki/', () => {
    expect(CODEBASE_WIKI_PACK.defaultSubfolder).toBeUndefined();
  });

  test('each section ships its named page template, resolvable in pack.templates', () => {
    const expected: Record<string, string> = {
      'wiki/architecture': 'architecture-page',
      'wiki/modules': 'module-page',
      'wiki/flows': 'flow-page',
      'wiki/concepts': 'concept-page',
      'wiki/guides': 'guide-page',
    };
    for (const folder of CODEBASE_WIKI_PACK.folders) {
      expect(folder.starterTemplate).toBe(expected[folder.path]);
      expect(CODEBASE_WIKI_PACK.templates[folder.starterTemplate]).toBeDefined();
    }
  });

  test('ships OVERVIEW + log root files, both prefixed under wiki/', () => {
    expect(Object.keys(CODEBASE_WIKI_PACK.rootFiles ?? {}).sort()).toEqual([
      'wiki/OVERVIEW.md',
      'wiki/log.md',
    ]);
  });

  test('OVERVIEW stub carries the profile + source_commit freshness anchors', () => {
    const overview = CODEBASE_WIKI_PACK.rootFiles?.['wiki/OVERVIEW.md'] ?? '';
    expect(overview).toContain('profile:');
    expect(overview).toContain('source_commit:');
  });
});

describe('buildStarterFolderFrontmatterYaml()', () => {
  test('emits title + description + tags for a folder', () => {
    const folder = STARTER_FOLDERS[0];
    if (!folder) throw new Error('STARTER_FOLDERS is empty');
    const yaml = buildStarterFolderFrontmatterYaml(folder);
    expect(yaml).toContain(`title: `);
    expect(yaml).toContain(`description:`);
    expect(yaml).toContain('tags:');
    for (const tag of folder.tags) {
      expect(yaml).toContain(`  - ${tag}`);
    }
    expect(yaml.endsWith('\n')).toBe(true);
  });

  test('quotes scalars containing colons (description prose)', () => {
    const yaml = buildStarterFolderFrontmatterYaml({
      path: 'x',
      title: 'X',
      description: 'A description: with a colon',
      tags: [],
      starterTemplate: 'clip',
    });
    // Description with a colon must be quoted to be valid YAML.
    expect(yaml).toContain('description: "A description: with a colon"');
  });
});

describe('listStarterPacks() — wire-shape + entryCounts', () => {
  test('returns one entry per registered pack id', () => {
    const packs = listStarterPacks();
    expect(packs.map((p) => p.id).sort()).toEqual([...STARTER_PACK_IDS].sort());
  });

  test('every pack ships a defined entryCounts with non-negative integers', () => {
    for (const pack of listStarterPacks()) {
      expect(pack.entryCounts).toBeDefined();
      expect(Number.isInteger(pack.entryCounts.files)).toBe(true);
      expect(Number.isInteger(pack.entryCounts.folders)).toBe(true);
      expect(pack.entryCounts.files).toBeGreaterThanOrEqual(0);
      expect(pack.entryCounts.folders).toBeGreaterThanOrEqual(0);
    }
  });

  test('entryCounts.folders matches pack.folders.length', () => {
    for (const pack of listStarterPacks()) {
      expect(pack.entryCounts.folders).toBe(STARTER_PACKS[pack.id].folders.length);
    }
  });

  test('entryCounts.files sums starter + extra templates and rootFiles', () => {
    for (const info of listStarterPacks()) {
      const src = STARTER_PACKS[info.id];
      let expected = 0;
      for (const folder of src.folders) {
        expected += 1 + (folder.extraTemplates?.length ?? 0);
      }
      expected += src.rootFiles ? Object.keys(src.rootFiles).length : 0;
      expect(info.entryCounts.files).toBe(expected);
    }
  });

  test('folder-only packs (no extras, no rootFiles) report files === folders.length', () => {
    const plainNotes = listStarterPacks().find((p) => p.id === 'plain-notes');
    expect(plainNotes).toBeDefined();
    // plain-notes has 2 folders, 1 starter template each, no extras, no rootFiles.
    expect(plainNotes?.entryCounts).toEqual({ files: 2, folders: 2 });
  });
});

describe('seeded content keeps illustrative example links out of the link graph', () => {
  // Placeholder targets used in instructional examples across the packs. None
  // may ever be EXTRACTED from a seeded rootFile or template body: an example
  // link must live in a code fence (block) or inline code (inline), so docs
  // instantiated from the seed don't carry phantom dead-links / "missing"
  // graph nodes. A bare HTML comment does NOT exclude links — that is the bug
  // this guards against.
  const EXAMPLE_TARGET_FRAGMENTS = [
    'acme',
    'jane-founder',
    'jane-co',
    'agent-runtime-observability',
    'doc-a',
    'doc-b',
    'source-slug',
    'another-concept',
    'path/to',
  ];

  function extractedTargets(markdown: string): string[] {
    return [
      ...extractMarkdownLinksFromMarkdown(markdown, 'log').map((l) => l.target),
      ...extractWikiLinksFromMarkdown(markdown).map((l) => l.target),
    ];
  }

  function assertNoExampleLeak(where: string, body: string): void {
    const targets = extractedTargets(body);
    const leaked = targets.filter((t) => EXAMPLE_TARGET_FRAGMENTS.some((frag) => t.includes(frag)));
    expect(leaked, `${where} leaks example link(s): ${leaked.join(', ')}`).toEqual([]);
  }

  test('no seeded rootFile or template body extracts an example placeholder link', () => {
    for (const packId of STARTER_PACK_IDS) {
      const pack = STARTER_PACKS[packId];
      for (const [name, body] of Object.entries(pack.rootFiles ?? {})) {
        assertNoExampleLeak(`${packId} rootFile ${name}`, body);
      }
      for (const [name, body] of Object.entries(pack.templates ?? {})) {
        // Strip the template-identity block so we test the instantiated doc body.
        assertNoExampleLeak(`${packId} template ${name}`, parseTemplateFile(body).starterContent);
      }
    }
  });

  test('no pack SKILL.md leaks an example placeholder link', () => {
    const packsDir = join(import.meta.dir, '..', '..', 'assets', 'skills', 'packs');
    for (const packId of STARTER_PACK_IDS) {
      const skillPath = join(packsDir, packId, 'SKILL.md');
      // Every pack ships a SKILL.md; fail loud (not silent skip) if one goes
      // missing, so the sweep can't quietly stop covering a pack.
      expect(existsSync(skillPath), `${packId} pack is missing SKILL.md`).toBe(true);
      assertNoExampleLeak(`${packId} SKILL.md`, readFileSync(skillPath, 'utf-8'));
    }
  });
});

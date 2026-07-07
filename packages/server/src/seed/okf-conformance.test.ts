/**
 * OKF starter pack — conformance test.
 *
 * The `okf` pack's whole value is that its scaffolded content is conformant
 * with Google's Open Knowledge Format (OKF) v0.1 BY CONSTRUCTION — there is no
 * shipped validator, so this test IS the verification surface. It runs the real
 * pack-agnostic seed pipeline (`planSeed` → `applySeed`) into a temp project and
 * asserts the three OKF §9 conformance rules over the bytes actually written:
 *
 *   rule 1: every non-reserved doc has a parseable YAML frontmatter block.
 *   rule 2: every such block carries a non-empty string `type`.
 *   rule 3: the reserved files (`index.md` §6, `log.md` §7) are lowercase,
 *           carry ZERO frontmatter, and match the §6/§7 body structure.
 *
 * Two non-reserved doc shapes are seeded and both are checked at the form an
 * OKF consumer sees:
 *   - `welcome.md` is a real content doc with a single frontmatter block —
 *     parsed directly.
 *   - the folder starter templates (`<folder>/.ok/templates/<name>.md`) are a
 *     single frontmatter block: the `template:` identity plus the doc-frontmatter
 *     top-level keys. `instantiateDoc` strips the identity and reconstructs the
 *     frontmatter the created doc receives (see api-extension create-page). So
 *     conformance is asserted on the instantiated doc-frontmatter.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  instantiateDoc,
  parseFrontmatterYaml,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { parse as parseYaml } from 'yaml';
import { applySubstitution } from '../content/substitution.ts';
import { applySeed } from './apply.ts';
import { planSeed } from './plan.ts';
import { OKF_RESERVED_FILENAMES, STARTER_PACKS } from './starter.ts';

const OKF_PACK = STARTER_PACKS.okf;
const OKF_INDEX_BODY = OKF_PACK.rootFiles?.['index.md'];
const OKF_LOG_BODY = OKF_PACK.rootFiles?.['log.md'];
if (!OKF_INDEX_BODY || !OKF_LOG_BODY) {
  throw new Error('okf pack is missing its reserved index.md / log.md root files');
}

/** Reserved OKF files, relative to the bundle (pack) root — shared with the pack. */
const RESERVED_FILES = new Set(OKF_RESERVED_FILENAMES);

/** Recursively collect every `.md` file under `dir`, returned project-relative. */
function collectMarkdown(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdown(root, abs));
    } else if (entry.name.endsWith('.md')) {
      out.push(relative(root, abs));
    }
  }
  return out;
}

/**
 * The frontmatter an OKF consumer would see for a seeded `.md`. For a folder
 * template (single-block: `template:` identity + doc-frontmatter top-level),
 * that is what an instantiated doc receives — `instantiateDoc` strips the
 * identity and reconstructs the doc-frontmatter block + body, to which we apply
 * the same `{{date}}`/`{{user}}` substitution `write({ template })` does (an
 * unsubstituted `created: {{date}}` is not valid YAML). For a plain content doc
 * (no template identity), the block IS the doc frontmatter. Returns the YAML
 * body (no `---` fences), or `null` when the doc has no frontmatter at all.
 */
function consumerFrontmatterYaml(relPath: string, raw: string): string | null {
  const isTemplate = relPath.includes('/.ok/templates/');
  const docSource = isTemplate
    ? applySubstitution(instantiateDoc(raw), { date: '2026-01-01', user: 'Test User' })
    : raw;
  const { frontmatter } = stripFrontmatter(docSource);
  if (frontmatter === '') return null;
  // Drop the `---` fences via the canonical core helper (the inverse of what
  // production uses) so this stays in lockstep with the real write path rather
  // than re-implementing a narrower fence regex.
  return unwrapFrontmatterFences(frontmatter);
}

async function seedOkf(): Promise<{ projectDir: string; cleanup: () => Promise<void> }> {
  const projectDir = await mkdtemp(join(tmpdir(), 'seed-okf-'));
  // planSeed's gate requires `.ok/config.yml`.
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), '', 'utf-8');
  const plan = await planSeed({ projectDir, packId: 'okf' });
  const result = await applySeed(plan, { projectDir, packId: 'okf' });
  expect(result.errors).toEqual([]);
  return {
    projectDir,
    cleanup: () => rm(projectDir, { recursive: true, force: true }),
  };
}

describe('okf pack — OKF §9 conformance by construction', () => {
  test('rule 1+2: every non-reserved seed .md parses to frontmatter with a non-empty type', async () => {
    const { projectDir, cleanup } = await seedOkf();
    try {
      const docs = collectMarkdown(projectDir).filter((p) => !RESERVED_FILES.has(p));
      // Guard against a vacuous pass: the single-block content doc (`welcome.md`)
      // and the folder templates must all be present + checked. Without the
      // explicit welcome.md guard the three templates alone satisfy the count,
      // so dropping the only non-template doc would pass silently.
      expect(docs).toContain('welcome.md');
      expect(docs.length).toBeGreaterThanOrEqual(4);

      for (const relPath of docs) {
        const raw = readFileSync(join(projectDir, relPath), 'utf-8');
        const yaml = consumerFrontmatterYaml(relPath, raw);
        expect(yaml, `${relPath}: rule 1 — no parseable frontmatter block`).not.toBeNull();

        const parsed = parseFrontmatterYaml(yaml ?? '');
        expect(
          parsed.map,
          `${relPath}: rule 1 — frontmatter failed to parse (${parsed.parseError ?? ''})`,
        ).not.toBeNull();

        const type = parsed.map?.type;
        expect(
          typeof type === 'string' && type.trim().length > 0,
          `${relPath}: rule 2 — \`type\` must be a non-empty string, got ${JSON.stringify(type)}`,
        ).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  test('rule 3: reserved index.md/log.md are lowercase, present at root, and carry ZERO frontmatter', async () => {
    const { projectDir, cleanup } = await seedOkf();
    try {
      for (const reserved of RESERVED_FILES) {
        const abs = join(projectDir, reserved);
        expect(existsSync(abs), `${reserved} must be seeded at the bundle root`).toBe(true);
        const raw = readFileSync(abs, 'utf-8');
        // The load-bearing rule-3 assertion: a reserved file with any
        // frontmatter is an OKF violation. A frontmatter block can only appear
        // at byte 0, so checking the leading fence is sufficient + precise.
        expect(raw.startsWith('---'), `${reserved} must NOT carry frontmatter`).toBe(false);
        expect(stripFrontmatter(raw).frontmatter, `${reserved} has a frontmatter block`).toBe('');
      }
    } finally {
      await cleanup();
    }
  });

  test('rule 3: index.md matches OKF §6 navigation structure (H1 + standard-markdown link list)', async () => {
    const { projectDir, cleanup } = await seedOkf();
    try {
      const index = readFileSync(join(projectDir, 'index.md'), 'utf-8');
      expect(index.startsWith('# '), 'index.md should open with an H1 navigation heading').toBe(
        true,
      );
      // §6 navigation is a link-list in STANDARD markdown — a conformant OKF
      // bundle's links are plain markdown, not OK's `[[…]]` superset (which the
      // OKF export normalizes away). Pin every seeded nav link's format so the
      // graph stays portable to a strict consumer.
      for (const link of [
        '[welcome](./welcome.md)',
        '[concepts/](./concepts/)',
        '[references/](./references/)',
        '[notes/](./notes/)',
      ]) {
        expect(index, `index.md should link ${link} in standard markdown`).toContain(link);
      }
      expect(index, 'seeded nav must not use [[wiki-link]] shorthand').not.toMatch(
        /\[\[[^\]]+\]\]/,
      );
    } finally {
      await cleanup();
    }
  });

  test('rule 3: log.md matches OKF §7 change-history structure (H1 + documents the dated-entry format)', async () => {
    const { projectDir, cleanup } = await seedOkf();
    try {
      const log = readFileSync(join(projectDir, 'log.md'), 'utf-8');
      expect(log.startsWith('# '), 'log.md should open with an H1 heading').toBe(true);
      // §7 entries are second-level headings shaped `## <date>: <summary>`. The
      // seed ships a prose instruction documenting that format (not a placeholder
      // entry — mirroring peer packs; root files get no `{{date}}` substitution
      // so a seeded date would be stale). Assert the format is documented.
      expect(log).toMatch(/## YYYY-MM-DD: <summary>/);
      expect(log.toLowerCase()).toContain('change history');
    } finally {
      await cleanup();
    }
  });

  test('apply writes the reserved-file bodies to disk verbatim (no {{date}} substitution on root files)', async () => {
    // Root files — unlike templates — are written byte-for-byte with NO
    // substitution. This pins that property (a regression that wired
    // substitution into rootFiles would corrupt the frontmatter-free reserved
    // files); the §6/§7 tests pin the body content/format itself.
    const { projectDir, cleanup } = await seedOkf();
    try {
      expect(readFileSync(join(projectDir, 'index.md'), 'utf-8')).toBe(OKF_INDEX_BODY);
      expect(readFileSync(join(projectDir, 'log.md'), 'utf-8')).toBe(OKF_LOG_BODY);
    } finally {
      await cleanup();
    }
  });

  test('idempotent + non-destructive: a second seed writes nothing new and never overwrites', async () => {
    const { projectDir, cleanup } = await seedOkf();
    try {
      // Mutate a seeded file to prove apply never clobbers user edits.
      const welcomeAbs = join(projectDir, 'welcome.md');
      writeFileSync(welcomeAbs, 'EDITED BY USER\n', 'utf-8');

      const plan2 = await planSeed({ projectDir, packId: 'okf' });
      expect(plan2.created, 're-run should plan zero new writes').toEqual([]);
      const result2 = await applySeed(plan2, { projectDir, packId: 'okf' });
      expect(result2.errors).toEqual([]);
      expect(result2.applied).toBe(0);
      expect(readFileSync(welcomeAbs, 'utf-8')).toBe('EDITED BY USER\n');
    } finally {
      await cleanup();
    }
  });

  test('rule 2 holds with an editor present: the installed pack skill markdown carries a non-empty type', async () => {
    // `installPackSkill` copies the pack skill into `.claude/skills/...` when a
    // platform skill is present, and OK admits skill markdown under those
    // dot-dirs into the content corpus — so the seeded skill doc is itself a
    // non-reserved content `.md` and must carry a non-empty `type` to keep the
    // pack's contract. The blank-temp-dir tests never install a skill, so
    // this case exercises the editor-present path explicitly.
    const projectDir = await mkdtemp(join(tmpdir(), 'seed-okf-skill-'));
    try {
      mkdirSync(join(projectDir, '.ok'), { recursive: true });
      writeFileSync(join(projectDir, '.ok', 'config.yml'), '', 'utf-8');
      // Platform skill present → installPackSkill installs the pack skill beside it.
      const platformSkillDir = join(projectDir, '.claude', 'skills', 'open-knowledge');
      mkdirSync(platformSkillDir, { recursive: true });
      writeFileSync(
        join(platformSkillDir, 'SKILL.md'),
        '---\nname: open-knowledge\n---\n',
        'utf-8',
      );

      const plan = await planSeed({ projectDir, packId: 'okf' });
      const result = await applySeed(plan, { projectDir, packId: 'okf' });
      expect(result.errors).toEqual([]);
      expect(result.packSkillsInstalled).toContain('Claude Code');

      // Every `.md` the pack installed under its skill dir must carry a non-empty `type`.
      const packSkillDir = join(projectDir, '.claude', 'skills', 'open-knowledge-pack-okf');
      const skillDocs = collectMarkdown(packSkillDir).map((p) => join(packSkillDir, p));
      expect(skillDocs.length).toBeGreaterThanOrEqual(1);
      for (const abs of skillDocs) {
        const raw = readFileSync(abs, 'utf-8');
        const { frontmatter } = stripFrontmatter(raw);
        expect(frontmatter, `${abs}: installed skill doc must carry frontmatter`).not.toBe('');
        const parsed = parseFrontmatterYaml(unwrapFrontmatterFences(frontmatter));
        const type = parsed.map?.type;
        expect(
          typeof type === 'string' && type.trim().length > 0,
          `${abs}: installed skill doc must carry a non-empty \`type\` (OKF rule 2), got ${JSON.stringify(type)}`,
        ).toBe(true);
      }
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

// Scope: the templates every pack ships — NOT a full-seed of every pack. A pack
// can also ship non-reserved root files (e.g. entity-vault's USER.md/SOUL.md)
// that carry no `type`; those are out of scope here (templates only). This guard
// keeps every pack's TEMPLATES rule-2 conformant so a new doc created from any
// pack is born OKF-portable.
describe('all starter packs — OKF §9 rule 2 (every template instantiates a typed doc)', () => {
  test('every template in every pack carries a non-empty type in its instantiated doc-frontmatter', () => {
    const packs = Object.values(STARTER_PACKS);
    // Guard against a vacuous pass if the registry is ever emptied.
    expect(packs.length).toBeGreaterThanOrEqual(7);

    for (const pack of packs) {
      const templates = Object.entries(pack.templates);
      expect(templates.length, `${pack.id}: pack defines no templates`).toBeGreaterThan(0);

      for (const [name, body] of templates) {
        // A template is a single frontmatter block (`template:` identity +
        // doc-frontmatter top-level keys); the instantiated doc receives the
        // doc-frontmatter. Reuse the same consumer-frontmatter derivation the
        // okf rule-1+2 test uses (`instantiateDoc` strips the identity, then
        // substitute + parse), so this stays format-agnostic.
        const relPath = `${pack.id}/.ok/templates/${name}.md`;
        const yaml = consumerFrontmatterYaml(relPath, body);
        expect(
          yaml,
          `${pack.id}/${name}: rule 1 — no parseable instantiated frontmatter`,
        ).not.toBeNull();

        // OKF rule 1 is just "parseable YAML" — use a plain YAML parse rather
        // than OK's schema-validating `parseFrontmatterYaml`, which rejects
        // intentionally-empty template fields (e.g. clip's `source_url:`) that
        // OKF tolerates.
        let map: unknown;
        try {
          map = parseYaml(yaml ?? '');
        } catch (err) {
          throw new Error(`${pack.id}/${name}: rule 1 — frontmatter is not valid YAML: ${err}`);
        }
        expect(
          map !== null && typeof map === 'object',
          `${pack.id}/${name}: rule 1 — frontmatter did not parse to a map`,
        ).toBe(true);

        const type = (map as Record<string, unknown>).type;
        expect(
          typeof type === 'string' && type.trim().length > 0,
          `${pack.id}/${name}: rule 2 — \`type\` must be a non-empty string, got ${JSON.stringify(type)}`,
        ).toBe(true);
      }
    }
  });
});

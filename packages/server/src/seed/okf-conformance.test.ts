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

const RESERVED_FILES = new Set(OKF_RESERVED_FILENAMES);

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

function consumerFrontmatterYaml(relPath: string, raw: string): string | null {
  const isTemplate = relPath.includes('/.ok/templates/');
  const docSource = isTemplate
    ? applySubstitution(instantiateDoc(raw), { date: '2026-01-01', user: 'Test User' })
    : raw;
  const { frontmatter } = stripFrontmatter(docSource);
  if (frontmatter === '') return null;
  return unwrapFrontmatterFences(frontmatter);
}

async function seedOkf(): Promise<{ projectDir: string; cleanup: () => Promise<void> }> {
  const projectDir = await mkdtemp(join(tmpdir(), 'seed-okf-'));
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
      expect(log).toMatch(/## YYYY-MM-DD: <summary>/);
      expect(log.toLowerCase()).toContain('change history');
    } finally {
      await cleanup();
    }
  });

  test('apply writes the reserved-file bodies to disk verbatim (no {{date}} substitution on root files)', async () => {
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
    const projectDir = await mkdtemp(join(tmpdir(), 'seed-okf-skill-'));
    try {
      mkdirSync(join(projectDir, '.ok'), { recursive: true });
      writeFileSync(join(projectDir, '.ok', 'config.yml'), '', 'utf-8');
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

describe('all starter packs — OKF §9 rule 2 (every template instantiates a typed doc)', () => {
  test('every template in every pack carries a non-empty type in its instantiated doc-frontmatter', () => {
    const packs = Object.values(STARTER_PACKS);
    expect(packs.length).toBeGreaterThanOrEqual(7);

    for (const pack of packs) {
      const templates = Object.entries(pack.templates);
      expect(templates.length, `${pack.id}: pack defines no templates`).toBeGreaterThan(0);

      for (const [name, body] of templates) {
        const relPath = `${pack.id}/.ok/templates/${name}.md`;
        const yaml = consumerFrontmatterYaml(relPath, body);
        expect(
          yaml,
          `${pack.id}/${name}: rule 1 — no parseable instantiated frontmatter`,
        ).not.toBeNull();

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

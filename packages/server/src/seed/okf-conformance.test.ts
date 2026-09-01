import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  DEFAULT_LINTER_CONFIG,
  instantiateDoc,
  type LinterConfig,
  lintDocument,
  parseFrontmatterYaml,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { computeBrokenOutboundLinks } from '../backlink-index.ts';
import { applySubstitution } from '../content/substitution.ts';
import { applySeed } from './apply.ts';
import { planSeed } from './plan.ts';
import { OKF_RESERVED_FILENAMES, type PackId, STARTER_PACKS } from './starter.ts';

const OKF_PACK = STARTER_PACKS.okf;
const OKF_INDEX_BODY = OKF_PACK.rootFiles?.['index.md'];
const OKF_GETTING_STARTED_BODY = OKF_PACK.rootFiles?.['concepts/getting-started.md'];
if (!OKF_INDEX_BODY || !OKF_GETTING_STARTED_BODY) {
  throw new Error('okf pack is missing its minimal portable bundle');
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

async function seedOkf(
  rootDir?: string,
): Promise<{ projectDir: string; cleanup: () => Promise<void> }> {
  const projectDir = await mkdtemp(join(tmpdir(), 'seed-okf-'));
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), '', 'utf-8');
  mkdirSync(join(projectDir, '.agents', 'skills'), { recursive: true });
  const plan = await planSeed({ projectDir, packId: 'okf', rootDir });
  const result = await applySeed(plan, { projectDir, packId: 'okf' });
  expect(result.errors).toEqual([]);
  return {
    projectDir,
    cleanup: () => rm(projectDir, { recursive: true, force: true }),
  };
}

async function seedPackSequence(
  order: readonly PackId[],
): Promise<{ projectDir: string; cleanup: () => Promise<void> }> {
  const projectDir = await mkdtemp(join(tmpdir(), 'seed-okf-compatible-packs-'));
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), '', 'utf-8');
  mkdirSync(join(projectDir, '.agents', 'skills'), { recursive: true });
  for (const packId of order) {
    const plan = await planSeed({ projectDir, packId });
    const result = await applySeed(plan, { projectDir, packId });
    expect(result.errors, `${packId} seed errors`).toEqual([]);
  }
  return {
    projectDir,
    cleanup: () => rm(projectDir, { recursive: true, force: true }),
  };
}

describe('okf pack — minimal starter contract', () => {
  test('ships one populated domain folder, one template, and two portable documents', () => {
    expect(OKF_PACK.folders.map((folder) => folder.path)).toEqual(['concepts']);
    expect(Object.keys(OKF_PACK.templates)).toEqual(['concept']);
    expect(Object.keys(OKF_PACK.rootFiles ?? {})).toEqual([
      'index.md',
      'concepts/getting-started.md',
    ]);
  });

  test('the companion skill targets v0.2 and explains the plugin rather than the scaffold', () => {
    const skillSource = readFileSync(
      join(import.meta.dirname, '..', '..', 'assets', 'skills', 'packs', 'okf', 'SKILL.md'),
      'utf-8',
    );
    const { frontmatter, body } = stripFrontmatter(skillSource);
    const parsed = parseFrontmatterYaml(unwrapFrontmatterFences(frontmatter));

    expect(parsed.map?.description).toContain('v0.2 guidance');
    expect(body).toContain("## OpenKnowledge's `okf` plugin");
    expect(body).toContain('continuous portability feedback');
    expect(body).not.toMatch(/starter pack/i);
  });
});

describe('okf pack — OKF §11 conformance by construction', () => {
  test('rule 1+2: every non-reserved seed .md parses to frontmatter with a non-empty type', async () => {
    const { projectDir, cleanup } = await seedOkf();
    try {
      const docs = collectMarkdown(projectDir).filter((p) => !RESERVED_FILES.has(p));
      expect(docs).toContain('concepts/getting-started.md');
      expect(docs).toContain('concepts/.ok/templates/concept.md');
      expect(docs.some((path) => path.endsWith('/SKILL.md'))).toBe(true);

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

  test('rule 3: the root index declares v0.2 and the optional log is omitted', async () => {
    const { projectDir, cleanup } = await seedOkf();
    try {
      const index = readFileSync(join(projectDir, 'index.md'), 'utf-8');
      expect(index.startsWith('---\nokf_version: "0.2"\n---\n')).toBe(true);
      expect(existsSync(join(projectDir, 'log.md'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test('rule 3: index.md matches OKF §8 navigation structure (H1 + standard-markdown link list)', async () => {
    const { projectDir, cleanup } = await seedOkf();
    try {
      const index = readFileSync(join(projectDir, 'index.md'), 'utf-8');

      expect(index.startsWith('---\nokf_version: "0.2"\n---\n'), 'root index frontmatter').toBe(
        true,
      );
      expect(index, 'index.md should have one navigation heading').toContain('# Knowledge base');
      expect(index, 'index.md should link the seeded guide').toContain(
        '[Getting started](./concepts/getting-started.md)',
      );

      expect(index, 'seeded nav must not use [[wiki-link]] shorthand').not.toMatch(
        /\[\[[^\]]+\]\]/,
      );
      expect(index, 'index.md must not link a bare folder').not.toMatch(/]\(\.\/[^)]*\/\)/);
      const seeded = collectMarkdown(projectDir).map((relPath) => relPath.replace(/\.mdx?$/, ''));
      expect(computeBrokenOutboundLinks(index, 'index', seeded)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test('seeding into a subdirectory keeps the portable bundle under that root', async () => {
    const { projectDir, cleanup } = await seedOkf('bundle');
    try {
      const bundleIndex = readFileSync(join(projectDir, 'bundle', 'index.md'), 'utf-8');

      expect(existsSync(join(projectDir, 'index.md'))).toBe(false);
      expect(bundleIndex).toContain('[Getting started](./concepts/getting-started.md)');
      expect(bundleIndex.startsWith('---\nokf_version: "0.2"\n---\n')).toBe(true);
      expect(existsSync(join(projectDir, 'bundle', 'concepts', 'index.md'))).toBe(false);

      const seeded = collectMarkdown(projectDir).map((relPath) => relPath.replace(/\.mdx?$/, ''));
      expect(computeBrokenOutboundLinks(bundleIndex, 'bundle/index', seeded)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test('a pre-existing bundle index is preserved while the typed document is added', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'seed-okf-existing-root-index-'));
    const existingIndex = '# User-authored bundle index\n';
    try {
      mkdirSync(join(projectDir, '.ok'), { recursive: true });
      writeFileSync(join(projectDir, '.ok', 'config.yml'), '', 'utf-8');
      mkdirSync(join(projectDir, 'bundle'), { recursive: true });
      writeFileSync(join(projectDir, 'bundle', 'index.md'), existingIndex, 'utf-8');

      const plan = await planSeed({ projectDir, packId: 'okf', rootDir: 'bundle' });
      const result = await applySeed(plan, { projectDir, packId: 'okf' });

      expect(result.errors).toEqual([]);
      expect(readFileSync(join(projectDir, 'bundle', 'index.md'), 'utf-8')).toBe(existingIndex);
      expect(existsSync(join(projectDir, 'bundle', 'concepts', 'getting-started.md'))).toBe(true);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test('apply writes the two portable documents to disk verbatim', async () => {
    const { projectDir, cleanup } = await seedOkf();
    try {
      expect(readFileSync(join(projectDir, 'index.md'), 'utf-8')).toBe(OKF_INDEX_BODY);
      expect(readFileSync(join(projectDir, 'concepts', 'getting-started.md'), 'utf-8')).toBe(
        OKF_GETTING_STARTED_BODY,
      );
    } finally {
      await cleanup();
    }
  });

  test('idempotent + non-destructive: a second seed writes nothing new and never overwrites', async () => {
    const { projectDir, cleanup } = await seedOkf();
    try {
      const guideAbs = join(projectDir, 'concepts', 'getting-started.md');
      writeFileSync(guideAbs, 'EDITED BY USER\n', 'utf-8');

      const plan2 = await planSeed({ projectDir, packId: 'okf' });
      expect(plan2.created, 're-run should plan zero new writes').toEqual([]);
      const result2 = await applySeed(plan2, { projectDir, packId: 'okf' });
      expect(result2.errors).toEqual([]);
      expect(result2.applied).toBe(0);
      expect(readFileSync(guideAbs, 'utf-8')).toBe('EDITED BY USER\n');
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

      const packSkillDir = join(projectDir, '.claude', 'skills', 'okf-knowledge-base');
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

const OKF_LINT_CONFIG: LinterConfig = {
  ...DEFAULT_LINTER_CONFIG,
  enabled: true,
  plugins: { ...DEFAULT_LINTER_CONFIG.plugins, okf: { enabled: true } },
};

describe('okf pack — the okf lint rules find nothing in the seeded bundle', () => {
  test('every produced .md, including the dot-directory templates and pack skill, yields zero okf findings', async () => {
    const { projectDir, cleanup } = await seedOkf();
    try {
      const files = collectMarkdown(projectDir);
      expect(files).toContain('index.md');
      expect(files).toContain('concepts/getting-started.md');
      expect(files).not.toContain('log.md');
      expect(files.filter((relPath) => relPath.endsWith('/index.md'))).toEqual([]);
      expect(files.some((relPath) => relPath.includes('.ok/templates/'))).toBe(true);
      expect(files.some((relPath) => relPath.endsWith('SKILL.md'))).toBe(true);

      for (const relPath of files) {
        const source = readFileSync(join(projectDir, relPath), 'utf-8');
        const findings = await lintDocument(source, OKF_LINT_CONFIG, relPath);
        const detail = findings
          .map(
            (f) =>
              `${f.code} @ ${f.range.start.line + 1}:${f.range.start.character + 1} — ${f.message}`,
          )
          .join('; ');
        expect(findings, `${relPath} produced okf findings: ${detail}`).toEqual([]);
      }
    } finally {
      await cleanup();
    }
  });
});

describe('knowledge-base + okf pack compatibility', () => {
  test.each([
    ['knowledge-base', 'okf'],
    ['okf', 'knowledge-base'],
  ] satisfies PackId[][])('both seed orders produce one clean OKF bundle: %s then %s', async (first, second) => {
    const order: PackId[] = [first, second];
    const { projectDir, cleanup } = await seedPackSequence(order);
    try {
      const files = collectMarkdown(projectDir);
      expect(files).toContain('index.md');
      expect(files).toContain('log.md');
      expect(files).toContain('external-sources/.ok/templates/clip.md');
      expect(files).toContain('research/.ok/templates/research-log.md');
      expect(files).toContain('articles/.ok/templates/article.md');

      const installedSkillNames = files
        .filter((relPath) => relPath.endsWith('/SKILL.md'))
        .map((relPath) => {
          const source = readFileSync(join(projectDir, relPath), 'utf-8');
          const { frontmatter } = stripFrontmatter(source);
          return parseFrontmatterYaml(unwrapFrontmatterFences(frontmatter)).map?.name;
        })
        .sort();
      expect(installedSkillNames).toEqual([
        'consolidate-notes',
        'knowledge-base',
        'okf-knowledge-base',
        'research-with-sources',
      ]);

      for (const relPath of files) {
        const source = readFileSync(join(projectDir, relPath), 'utf-8');
        const findings = await lintDocument(source, OKF_LINT_CONFIG, relPath);
        expect(
          findings,
          `${order.join(' → ')}: ${relPath} produced ${findings.map((f) => f.code).join(', ')}`,
        ).toEqual([]);
      }
    } finally {
      await cleanup();
    }
  });
});

describe('all starter packs — OKF §11 rule 2 (every template instantiates a typed doc)', () => {
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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { commitWip, initShadowRepo, type WriterIdentity } from '@inkeep/open-knowledge-server';
import simpleGit from 'simple-git';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import type { EnrichedMeta } from '../../content/enrichment.ts';
import {
  buildExecResult,
  DESCRIPTION,
  type ExecStructuredResult,
  RESULT_BODY_BUDGET_BYTES,
  WIRE_BODY_COPIES,
} from './exec.ts';
import { bindTestUiLock } from './preview-url-test-helpers.ts';

describe('exec DESCRIPTION — STOP-rule anchoring (SPEC 2026-04-22 FR4 / US-007 / QA-009)', () => {
  test('total length fits Claude per-tool 2 KB cap', () => {
    expect(DESCRIPTION.length).toBeLessThanOrEqual(2048);
  });

  test('first 500 bytes contain STOP + (Read|Grep|Glob) + (.md|markdown)', () => {
    const head = DESCRIPTION.substring(0, 500);
    expect(head).toContain('STOP');
    const mentionsNativeTool =
      head.includes('Read') || head.includes('Grep') || head.includes('Glob');
    expect(mentionsNativeTool).toBe(true);
    const mentionsMarkdown = head.includes('.md') || head.includes('markdown');
    expect(mentionsMarkdown).toBe(true);
  });

  test('preserves pre-existing description shape (allowlist + cwd + examples)', () => {
    expect(DESCRIPTION).toContain('Allowlist: cat, ls, grep, find');
    expect(DESCRIPTION).toContain('cwd:');
    expect(DESCRIPTION).toContain('Examples:');
  });
});

const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

function fileEntries(s: ExecStructuredResult): EnrichedMeta[] {
  return s.enrichedPaths.filter(
    (e): e is EnrichedMeta => (e as { type?: string }).type !== 'directory',
  );
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-exec-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function bootstrap(): Promise<string> {
  const project = resolve(tmpDir, 'project');
  mkdirSync(project, { recursive: true });
  const git = simpleGit(project);
  await git.init();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 't@t.test');
  writeFileSync(resolve(project, 'README.md'), '# probe\n');
  await git.add('README.md');
  await git.commit('init');
  return project;
}

interface ExecResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function structured(result: ExecResult): ExecStructuredResult & { text?: string } {
  return result.structuredContent as unknown as ExecStructuredResult & { text?: string };
}

describe('exec — happy path', () => {
  test('cat single file returns raw stdout + enrichment block + structuredContent', async () => {
    const project = await bootstrap();
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(
      resolve(contentDir, 'auth.md'),
      '---\ntitle: Auth\ndescription: OAuth\ntags:\n  - auth\n---\n\nBody\n',
    );

    const result = (await buildExecResult(
      { command: 'cat content/auth.md' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Body');
    expect(result.content[0].text).toContain('### Referenced files');
    expect(result.content[0].text).toContain('Auth');

    const s = structured(result);
    const files = fileEntries(s);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('content/auth.md');
    expect(files[0].title).toBe('Auth');
    expect(files[0].historySource).toBe('shadow-repo-absent');
  });

  test('ls returns slim enrichment for each matched path', async () => {
    const project = await bootstrap();
    const contentDir = resolve(project, 'articles');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'auth.md'), '---\ntitle: Auth\n---\nBody');
    writeFileSync(resolve(contentDir, 'sso.md'), '---\ntitle: SSO\n---\nBody');

    const result = (await buildExecResult(
      { command: 'ls articles/' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    const files = fileEntries(s);
    expect(files.length).toBe(2);
    for (const m of files) {
      expect(m.backlinkCount).toBe(null);
      expect(m.history).toBe(null);
      expect(m.historySource).toBe(null);
    }
  });

  test('pipe works: grep | head with enrichment on matches', async () => {
    const project = await bootstrap();
    const contentDir = resolve(project, 'articles');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'a.md'), '---\ntitle: A\n---\noauth flow');
    writeFileSync(resolve(contentDir, 'b.md'), '---\ntitle: B\n---\noauth example');
    writeFileSync(resolve(contentDir, 'c.md'), '---\ntitle: C\n---\nunrelated');

    const result = (await buildExecResult(
      { command: 'grep -rn oauth articles/ | head -5' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(result.isError).toBeFalsy();
    const s = structured(result);
    const paths = s.enrichedPaths.map((p) => p.path);
    expect(paths).toContain('articles/a.md');
    expect(paths).toContain('articles/b.md');
    expect(paths).not.toContain('articles/c.md');
  });

  test('ls surfaces directory entries with folder metadata', async () => {
    const project = await bootstrap();
    const specs = resolve(project, 'specs');
    const specA = resolve(specs, 'spec-a');
    const specAEvidence = resolve(specA, 'evidence');
    mkdirSync(specAEvidence, { recursive: true });
    writeFileSync(resolve(specA, 'SPEC.md'), '---\ntitle: Spec A\n---\nBody\n');
    writeFileSync(resolve(specAEvidence, 'e1.md'), '---\ntitle: E1\n---\nBody\n');
    mkdirSync(resolve(specs, 'spec-b'), { recursive: true });
    writeFileSync(resolve(specs, 'spec-b', 'SPEC.md'), '---\ntitle: Spec B\n---\nBody\n');

    const result = (await buildExecResult(
      { command: 'ls specs/' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(result.isError).toBeFalsy();
    const s = structured(result);
    const dirs = s.enrichedPaths.filter(
      (e): e is Extract<typeof e, { type: 'directory' }> =>
        (e as { type?: string }).type === 'directory',
    );
    expect(dirs.length).toBe(3);
    const parentEntry = dirs.find((d) => d.path === 'specs');
    expect(parentEntry).toBeDefined();
    const specAEntry = dirs.find((d) => d.path === 'specs/spec-a');
    expect(specAEntry).toBeDefined();
    expect(specAEntry?.directMdCount).toBe(1);
    expect(specAEntry?.recursiveMdCount).toBe(2);
    expect(specAEntry?.childDirCount).toBe(1);
    expect(specAEntry?.mostRecentMd).toBeDefined();
    expect(result.content[0].text).toContain('specs/spec-a/');
    expect(result.content[0].text).toContain('md file');
  });

  test('ls with explicit dir arg surfaces nested .ok/frontmatter.yml folder defaults', async () => {
    const project = await bootstrap();
    const specs = resolve(project, 'specs');
    const specsOk = resolve(specs, '.ok');
    mkdirSync(specsOk, { recursive: true });
    writeFileSync(resolve(specs, 'foo.md'), '# Foo\n');
    writeFileSync(
      resolve(specsOk, 'frontmatter.yml'),
      'title: Specs\ndescription: Specifications\ntags: [spec]\n',
    );

    const result = (await buildExecResult(
      { command: 'ls specs/' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    const dirs = s.enrichedPaths.filter(
      (e): e is Extract<typeof e, { type: 'directory' }> =>
        (e as { type?: string }).type === 'directory',
    );
    const parent = dirs.find((d) => d.path === 'specs');
    expect(parent).toBeDefined();
    expect(parent?.title).toBe('Specs');
    expect(parent?.description).toBe('Specifications');
    expect(parent?.tags).toEqual(['spec']);
  });

  test("ls <dir> surfaces the folder's own well-known frontmatter keys + templates_available", async () => {
    const project = await bootstrap();
    const specs = resolve(project, 'specs');
    const specsOk = resolve(specs, '.ok');
    const specsOkTemplates = resolve(specsOk, 'templates');
    mkdirSync(specsOkTemplates, { recursive: true });
    writeFileSync(resolve(specs, 'foo.md'), '# Foo\n');
    writeFileSync(
      resolve(specsOk, 'frontmatter.yml'),
      'title: Specs\ndescription: Specifications\ntags: [spec]\nstatus: draft\n',
    );
    writeFileSync(
      resolve(specsOkTemplates, 'rfc.md'),
      '---\ntitle: RFC\ndescription: Request for comments\n---\n# RFC\n\nBody.\n',
    );

    const result = (await buildExecResult(
      { command: 'ls specs/' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    const dirs = s.enrichedPaths.filter(
      (e): e is Extract<typeof e, { type: 'directory' }> =>
        (e as { type?: string }).type === 'directory',
    );
    const parent = dirs.find((d) => d.path === 'specs');
    expect(parent).toBeDefined();
    expect(parent?.title).toBe('Specs');
    expect(parent?.description).toBe('Specifications');
    expect(parent?.tags).toEqual(['spec']);
    expect(parent?.templates_available).toBeDefined();
    expect(parent?.templates_available?.length).toBeGreaterThan(0);
    const rfc = parent?.templates_available?.find((t) => t.name === 'rfc');
    expect(rfc).toBeDefined();
    expect(rfc?.title).toBe('RFC');
    expect(rfc?.description).toBe('Request for comments');
  });
});

describe('exec — stdout provenance headers', () => {
  test('`ls <dir>/` prepends `<dir>/:` header to stdout', async () => {
    const project = await bootstrap();
    const contentDir = resolve(project, 'articles');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'auth.md'), '# Auth\n');

    const result = (await buildExecResult(
      { command: 'ls articles/' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    expect(s.text?.startsWith('articles/:\n')).toBe(true);
    expect(result.content[0].text).toContain('articles/:\n');
  });

  test('`ls .` emits no header (no explicit subject dir)', async () => {
    const project = await bootstrap();
    writeFileSync(resolve(project, 'top.md'), '# Top\n');

    const result = (await buildExecResult(
      { command: 'ls .' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    expect(s.text?.startsWith('./:')).toBe(false);
    expect(s.text?.startsWith('.:')).toBe(false);
  });

  test('`cat <file.md>` prepends `==> <file> <==` header to stdout', async () => {
    const project = await bootstrap();
    const contentDir = resolve(project, 'articles');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'auth.md'), '# Auth\n\nBody\n');

    const result = (await buildExecResult(
      { command: 'cat articles/auth.md' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    expect(s.text?.startsWith('==> articles/auth.md <==\n')).toBe(true);
  });

  test('multi-file `cat a.md b.md` emits no header (would imply false boundaries)', async () => {
    const project = await bootstrap();
    const contentDir = resolve(project, 'articles');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'a.md'), 'A\n');
    writeFileSync(resolve(contentDir, 'b.md'), 'B\n');

    const result = (await buildExecResult(
      { command: 'cat articles/a.md articles/b.md' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    expect(s.text).not.toContain('==>');
    const files = fileEntries(s);
    expect(files.map((f) => f.path).sort()).toEqual(['articles/a.md', 'articles/b.md']);
  });

  test('`head <file.md>` prepends file header AND enriches the file', async () => {
    const project = await bootstrap();
    const contentDir = resolve(project, 'articles');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'auth.md'), '---\ntitle: Auth\n---\nBody\n');

    const result = (await buildExecResult(
      { command: 'head -5 articles/auth.md' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    expect(s.text?.startsWith('==> articles/auth.md <==\n')).toBe(true);
    const files = fileEntries(s);
    expect(files.some((f) => f.path === 'articles/auth.md')).toBe(true);
  });

  test('`cat X | head -5` — cat header wins, head is a trimmer', async () => {
    const project = await bootstrap();
    const contentDir = resolve(project, 'articles');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'auth.md'), 'line 1\nline 2\nline 3\n');

    const result = (await buildExecResult(
      { command: 'cat articles/auth.md | head -2' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    expect(s.text).toContain('==> articles/auth.md <==\n');
  });
});

describe('exec — categorized errors', () => {
  test('unknown_command when first token not in allowlist', async () => {
    const project = await bootstrap();
    const result = (await buildExecResult(
      { command: 'awk BEGIN{}' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(result.isError).toBe(true);
    const s = structured(result);
    expect(s.error?.category).toBe('unknown_command');
    expect(s.error?.message).toContain('allowlist');
  });

  test('write_blocked on redirection', async () => {
    const project = await bootstrap();
    const result = (await buildExecResult(
      { command: 'grep x . > out.txt' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(result.isError).toBe(true);
    expect(structured(result).error?.category).toBe('write_blocked');
  });

  test('shell_construct_blocked on subshell', async () => {
    const project = await bootstrap();
    const result = (await buildExecResult(
      { command: 'cat `ls`' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(result.isError).toBe(true);
    expect(structured(result).error?.category).toBe('shell_construct_blocked');
  });
});

describe('exec — binary file NG8 warning', () => {
  test('cat on an image path produces warning banner', async () => {
    const project = await bootstrap();
    const contentDir = resolve(project, 'assets');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'diagram.png'), 'PNG\x00binary');

    const result = (await buildExecResult(
      { command: 'cat assets/diagram.png' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(result.content[0].text).toContain('appears to be binary');
    expect(result.content[0].text).toContain('native Read');
  });
});

describe('exec — cat enrichment carries shadow-repo history with writer attribution', () => {
  test('cat returns frontmatter + shadow-repo history with agent classification', async () => {
    const project = await bootstrap();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'articles');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(
      resolve(contentDir, 'parity.md'),
      '---\ntitle: Parity\ndescription: Test\ntags:\n  - x\n---\n\nBody\n',
    );
    const writer: WriterIdentity = { id: 'agent-x', name: 'X', email: 'x@t.test' };
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();
    await commitWip(shadow, writer, contentDir, 'wrote parity', branch);

    const execResult = (await buildExecResult(
      { command: 'cat articles/parity.md' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;
    const execMeta = fileEntries(structured(execResult))[0];

    expect(execMeta.title).toBe('Parity');
    expect(execMeta.tags).toEqual(['x']);
    expect(execMeta.historySource).toBe('shadow-repo');
    expect(execMeta.history?.length).toBe(1);
    expect(execMeta.history?.[0].writerClassification).toBe('agent');
  });
});

describe('exec — head/tail truncation banner', () => {
  async function seed(project: string, nFiles: number, linesPerFile: number): Promise<void> {
    const content = resolve(project, 'content');
    mkdirSync(content, { recursive: true });
    for (let i = 0; i < nFiles; i++) {
      const body = Array.from({ length: linesPerFile }, (_, j) => `line ${j} needle`).join('\n');
      writeFileSync(resolve(content, `doc${String(i).padStart(3, '0')}.md`), `${body}\n`);
    }
  }

  test('warns when `grep | head -N` hits its cap', async () => {
    const project = await bootstrap();
    await seed(project, 5, 20); // 5 files × 20 lines = 100 matching lines, capped to 10

    const result = (await buildExecResult(
      { command: 'grep -rn needle content/ | head -10' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/Output hit `head -10` cap/);
    expect(text).toMatch(/grep -rl PATTERN <dir>/);
  });

  test('does NOT warn when output is below the head cap', async () => {
    const project = await bootstrap();
    await seed(project, 1, 3); // only 3 matches, below head -10 default

    const result = (await buildExecResult(
      { command: 'grep -rn needle content/ | head' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toMatch(/Output hit/);
  });

  test('does NOT warn on single-stage commands (no head/tail at end)', async () => {
    const project = await bootstrap();
    await seed(project, 3, 5);

    const result = (await buildExecResult(
      { command: 'grep -rn needle content/' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toMatch(/Output hit/);
  });

  test('warns on `tail -N` truncation too', async () => {
    const project = await bootstrap();
    await seed(project, 5, 10);

    const result = (await buildExecResult(
      { command: 'grep -rn needle content/ | tail -5' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Output hit `tail -5` cap/);
  });

  test('recognizes `-n N` flag form', async () => {
    const project = await bootstrap();
    await seed(project, 5, 10);

    const result = (await buildExecResult(
      { command: 'grep -rn needle content/ | head -n 8' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Output hit `head -8` cap/);
  });
});

describe('exec — structuredContent mirrors body text + warnings (Desktop fix)', () => {
  async function seed(project: string, nFiles: number, linesPerFile: number): Promise<void> {
    const content = resolve(project, 'content');
    mkdirSync(content, { recursive: true });
    for (let i = 0; i < nFiles; i++) {
      const body = Array.from({ length: linesPerFile }, (_, j) => `line ${j} needle`).join('\n');
      writeFileSync(resolve(content, `doc${String(i).padStart(3, '0')}.md`), `${body}\n`);
    }
  }

  test('body rides structuredContent.text; raw stdout copy is dropped (PRD-6937)', async () => {
    const project = await bootstrap();
    const content = resolve(project, 'content');
    mkdirSync(content, { recursive: true });
    writeFileSync(resolve(content, 'a.md'), '---\ntitle: A\n---\n\nalpha body\n');

    const result = (await buildExecResult(
      { command: 'cat content/a.md' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    expect(result.content[0].text).toContain('alpha body');
    expect(typeof s.text).toBe('string');
    expect(s.text).toContain('alpha body');
    expect('stdout' in (result.structuredContent ?? {})).toBe(false);
    expect(s.stdoutTruncated).toBe(false);
  });

  test('body is emitted exactly twice on the wire (content[].text + structuredContent.text)', async () => {
    const project = await bootstrap();
    const content = resolve(project, 'content');
    mkdirSync(content, { recursive: true });
    const token = 'WIRE_DEDUP_NEEDLE_3F9A';
    writeFileSync(resolve(content, 'one.md'), `# Doc\n\nfirst ${token} only\n`);

    const result = (await buildExecResult(
      { command: 'cat content/one.md' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(structured(result).stdoutTruncated).toBe(false);
    const occurrences = JSON.stringify(result).split(token).length - 1;
    expect(occurrences).toBe(2);
  });

  test('mid-size cat stays within the realized per-copy + total wire budget (was 3× overflow)', async () => {
    const project = await bootstrap();
    const content = resolve(project, 'content');
    mkdirSync(content, { recursive: true });
    const line = `lorem ipsum dolor sit amet consectetur adipiscing elit ${'x'.repeat(40)}`;
    const body = Array.from({ length: 600 }, () => line).join('\n'); // ~60 KB raw
    const fm =
      '---\ntitle: Big Doc\ndescription: a mid-size doc with frontmatter\ntags: [alpha, beta, gamma]\n---\n';
    writeFileSync(resolve(content, 'big.md'), `${fm}# Big\n\n${body}\n`);

    const result = (await buildExecResult(
      { command: 'cat content/big.md' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    expect(structured(result).stdoutTruncated).toBe(true);
    expect(result.content[0].text).toContain('truncated');
    const perCopyBudget = Math.floor(RESULT_BODY_BUDGET_BYTES / WIRE_BODY_COPIES);
    expect(result.content[0].text.length).toBeLessThan(perCopyBudget);
    expect(JSON.stringify(result).length).toBeLessThan(RESULT_BODY_BUDGET_BYTES);
  });

  test('structuredContent.warnings includes head-cap truncation banner', async () => {
    const project = await bootstrap();
    await seed(project, 5, 20);

    const result = (await buildExecResult(
      { command: 'grep -rn needle content/ | head -10' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    expect(s.warnings).toBeDefined();
    expect(s.warnings?.some((w) => /Output hit `head -10` cap/.test(w))).toBe(true);
  });

  test('structuredContent.warnings absent when no banner fires', async () => {
    const project = await bootstrap();
    const content = resolve(project, 'content');
    mkdirSync(content, { recursive: true });
    writeFileSync(resolve(content, 'tiny.md'), 'only a few lines\n');

    const result = (await buildExecResult(
      { command: 'cat content/tiny.md' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    expect(s.warnings).toBeUndefined();
  });

  test('stdoutTruncated true when soft-cap applies', async () => {
    const project = await bootstrap();
    const content = resolve(project, 'content');
    mkdirSync(content, { recursive: true });
    const body = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
    writeFileSync(resolve(content, 'big.md'), `${body}\n`);

    const result = (await buildExecResult(
      { command: 'cat content/big.md' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    expect(s.stdoutTruncated).toBe(true);
  });
});

describe('exec — per-row route-only previewUrl (FR-2.2)', () => {
  test('emits a route-only previewUrl per enriched file; no top-level ui block', async () => {
    const project = await bootstrap();
    bindTestUiLock(project);
    const contentDir = resolve(project, 'articles');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'auth.md'), '---\ntitle: Auth\n---\nBody');
    writeFileSync(resolve(contentDir, 'sso.md'), '---\ntitle: SSO\n---\nBody');

    const result = (await buildExecResult(
      { command: 'ls articles/' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    const files = fileEntries(s);
    expect(files.length).toBe(2);
    for (const f of files) {
      const docName = f.path.replace(/\.(md|mdx)$/i, '');
      expect((f as unknown as { previewUrl: string }).previewUrl).toBe(`/#/${docName}`);
      expect((f as unknown as { previewUrlSource: string }).previewUrlSource).toBe('lock');
    }
    expect((s as unknown as { ui?: unknown }).ui).toBeUndefined();
  });

  test('previewUrl null when resolver returns null', async () => {
    const project = await bootstrap();
    const contentDir = resolve(project, 'articles');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'auth.md'), '---\ntitle: Auth\n---\nBody');

    const result = (await buildExecResult(
      { command: 'ls articles/' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    const files = fileEntries(s);
    expect(files.length).toBe(1);
    expect((files[0] as unknown as { previewUrl: string | null }).previewUrl).toBeNull();
    expect((s as unknown as { ui?: unknown }).ui).toBeUndefined();
  });

  test('mcp-tool-path-traversal: `ls ../etc/` does not enrich a directory outside cwd', async () => {
    const project = await bootstrap();
    const result = (await buildExecResult(
      { command: 'ls ../' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    for (const entry of s.enrichedPaths) {
      expect(entry.path.startsWith('../')).toBe(false);
      expect(entry.path).not.toBe('..');
      expect(entry.path.startsWith('/')).toBe(false);
    }
  });

  test('mcp-tool-path-traversal: `cat /etc/passwd.md`-style absolute path is dropped from enrichedPaths', async () => {
    const project = await bootstrap();
    const result = (await buildExecResult(
      { command: 'cat /etc/passwd' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;

    const s = structured(result);
    for (const entry of s.enrichedPaths) {
      expect(entry.path.startsWith('/')).toBe(false);
      expect(entry.path.startsWith('../')).toBe(false);
    }
  });

  test('FR13: nested .ok/ paths are filtered from enrichedPaths (not surfaced as listings)', async () => {
    const project = await bootstrap();
    const meetings = resolve(project, 'meetings');
    const meetingsOkTpls = resolve(meetings, '.ok', 'templates');
    mkdirSync(meetingsOkTpls, { recursive: true });
    writeFileSync(resolve(meetingsOkTpls, 'prep-notes.md'), '---\ntitle: Prep\n---\nbody\n');
    writeFileSync(resolve(meetings, '2026-05-01.md'), '---\ntitle: Meeting\n---\nbody\n');

    const result = (await buildExecResult(
      { command: 'find meetings -name "*.md"' },
      { resolveCwd: async () => project, serverUrl: undefined, config: DEFAULT_CONFIG },
    )) as ExecResult;
    const s = structured(result);
    const paths = s.enrichedPaths.map((e) => e.path);
    expect(paths).toContain('meetings/2026-05-01.md');
    expect(paths.some((p) => p.includes('.ok/'))).toBe(false);
  });
});

describe('exec — explicit subdirectory cwd', () => {
  function walkUpResolveCwd(start: string): string {
    let dir = resolve(start);
    for (;;) {
      if (existsSync(resolve(dir, '.ok', 'config.yml'))) return dir;
      const parent = resolve(dir, '..');
      if (parent === dir) throw new Error(`no OK project at or above ${start}`);
      dir = parent;
    }
  }

  async function bootstrapWithMarker(): Promise<{ project: string; subdir: string }> {
    const project = await bootstrap();
    mkdirSync(resolve(project, '.ok'), { recursive: true });
    writeFileSync(resolve(project, '.ok', 'config.yml'), 'content:\n  dir: .\n');
    const subdir = resolve(project, 'subdir');
    mkdirSync(subdir, { recursive: true });
    return { project, subdir };
  }

  test('runs in the passed subdir — bare subdir-relative path resolves', async () => {
    const { subdir } = await bootstrapWithMarker();
    writeFileSync(resolve(subdir, 'UNIQUE_MARKER.md'), 'marker contents\n');

    const result = (await buildExecResult(
      { command: 'cat UNIQUE_MARKER.md', cwd: subdir },
      {
        resolveCwd: async (explicit) => walkUpResolveCwd(explicit ?? subdir),
        serverUrl: undefined,
        config: DEFAULT_CONFIG,
      },
    )) as ExecResult;

    expect(result.isError).toBeFalsy();
    expect(structured(result).text).toContain('marker contents');
  });

  test('structuredContent.cwd reports the passed subdir, not the walked-up root', async () => {
    const { project, subdir } = await bootstrapWithMarker();
    writeFileSync(resolve(subdir, 'UNIQUE_MARKER.md'), 'marker contents\n');

    const result = (await buildExecResult(
      { command: 'cat UNIQUE_MARKER.md', cwd: subdir },
      {
        resolveCwd: async (explicit) => walkUpResolveCwd(explicit ?? subdir),
        serverUrl: undefined,
        config: DEFAULT_CONFIG,
      },
    )) as ExecResult;

    expect(structured(result).cwd).toBe(subdir);
    expect(structured(result).cwd).not.toBe(project);
  });

  test('enrichment addresses subdir files project-relative (docName under the root)', async () => {
    const { subdir } = await bootstrapWithMarker();
    writeFileSync(resolve(subdir, 'note.md'), '---\ntitle: Subdir Note\n---\n\nBody\n');

    const result = (await buildExecResult(
      { command: 'cat note.md', cwd: subdir },
      {
        resolveCwd: async (explicit) => walkUpResolveCwd(explicit ?? subdir),
        serverUrl: undefined,
        config: DEFAULT_CONFIG,
      },
    )) as ExecResult;

    expect(result.isError).toBeFalsy();
    const files = fileEntries(structured(result));
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('subdir/note.md');
    expect(files[0].title).toBe('Subdir Note');
    expect(structured(result).text?.startsWith('==> subdir/note.md <==\n')).toBe(true);
  });

  test('ls provenance header is rebased to the project-relative dir from a subdir', async () => {
    const { subdir } = await bootstrapWithMarker();
    const inner = resolve(subdir, 'inner');
    mkdirSync(inner, { recursive: true });
    writeFileSync(resolve(inner, 'doc.md'), '---\ntitle: Inner\n---\nBody');

    const result = (await buildExecResult(
      { command: 'ls inner/', cwd: subdir },
      {
        resolveCwd: async (explicit) => walkUpResolveCwd(explicit ?? subdir),
        serverUrl: undefined,
        config: DEFAULT_CONFIG,
      },
    )) as ExecResult;

    expect(result.isError).toBeFalsy();
    expect(structured(result).text?.startsWith('subdir/inner/:\n')).toBe(true);
  });

  test('passing the project root still runs there (unchanged behavior)', async () => {
    const { project } = await bootstrapWithMarker();
    const articles = resolve(project, 'articles');
    mkdirSync(articles, { recursive: true });
    writeFileSync(resolve(articles, 'auth.md'), '---\ntitle: Auth\n---\nBody');

    const result = (await buildExecResult(
      { command: 'cat articles/auth.md', cwd: project },
      {
        resolveCwd: async (explicit) => walkUpResolveCwd(explicit ?? project),
        serverUrl: undefined,
        config: DEFAULT_CONFIG,
      },
    )) as ExecResult;

    expect(result.isError).toBeFalsy();
    expect(structured(result).cwd).toBe(project);
    expect(fileEntries(structured(result))[0].path).toBe('articles/auth.md');
  });
});

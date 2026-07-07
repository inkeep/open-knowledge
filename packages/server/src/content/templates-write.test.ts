import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTemplateDelete, applyTemplateMove, applyTemplateWrite } from './templates-write.ts';

describe('applyTemplateWrite', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'tpl-write-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test('lazy-creates .ok/templates/ and writes the file', () => {
    const result = applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'prep-notes',
      body: '# Meeting Prep\n\nNotes...',
      frontmatter: {
        title: 'Meeting Prep',
        description: 'Use before a meeting.',
        tags: ['meeting'],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.path).toBe('meetings/.ok/templates/prep-notes.md');
    expect(result.warnings).toEqual([]);

    const abs = join(projectDir, 'meetings', '.ok', 'templates', 'prep-notes.md');
    const content = readFileSync(abs, 'utf-8');
    expect(content).toContain('title: Meeting Prep');
    expect(content).toContain('description: Use before a meeting.');
    expect(content).toContain('tags:');
    expect(content).toContain('# Meeting Prep');
  });

  test('overwrites existing template (idempotent)', () => {
    applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'prep',
      body: 'first',
      frontmatter: { title: 'V1', description: 'first version' },
    });
    const result = applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'prep',
      body: 'second',
      frontmatter: { title: 'V2', description: 'second version' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    const abs = join(projectDir, 'meetings', '.ok', 'templates', 'prep.md');
    const content = readFileSync(abs, 'utf-8');
    expect(content).toContain('title: V2');
    expect(content).toContain('second');
    expect(content).not.toContain('V1');
  });

  test('hard-errors on missing title with TEMPLATE_TITLE_REQUIRED (D14)', () => {
    const result = applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'untitled',
      body: 'body',
      frontmatter: { description: 'has desc only' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TEMPLATE_TITLE_REQUIRED');
  });

  test('hard-errors on empty title with TEMPLATE_TITLE_REQUIRED (D14)', () => {
    const result = applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'empty-title',
      body: 'body',
      frontmatter: { title: '', description: 'desc' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TEMPLATE_TITLE_REQUIRED');
  });

  test('rejects unknown substitution tokens with TEMPLATE_UNKNOWN_VARIABLE (D5 / FR17)', () => {
    const result = applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'bad-tokens',
      body: 'Today is {{date}}, but {{name}} is unknown.',
      frontmatter: { title: 'OK', description: 'tests rejection' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TEMPLATE_UNKNOWN_VARIABLE');
    expect(result.error.message).toContain('name');
  });

  test('accepts allowlisted substitution tokens (D5 / FR17)', () => {
    const result = applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'good-tokens',
      body: 'Date: {{date}}\nUser: {{user}}',
      frontmatter: { title: 'OK', description: 'allowlist passes' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
  });

  test('soft-warns on missing description (D14)', () => {
    const result = applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'undescribed',
      body: 'body',
      frontmatter: { title: 'Has Title' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.match(/description is missing/))).toBe(true);
  });

  test('rejects bad name (BAD_NAME)', () => {
    const result = applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'foo/bar',
      body: 'body',
      frontmatter: { title: 'X', description: 'X' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('BAD_NAME');
  });

  test('rejects path traversal (PATH_TRAVERSAL)', () => {
    const result = applyTemplateWrite({
      projectDir,
      folder: '../escape',
      name: 'foo',
      body: 'body',
      frontmatter: { title: 'X', description: 'X' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PATH_TRAVERSAL');
  });

  test('writes at project root (folder: "")', () => {
    const result = applyTemplateWrite({
      projectDir,
      folder: '',
      name: 'global',
      body: 'g',
      frontmatter: { title: 'Global', description: 'Available everywhere' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe('.ok/templates/global.md');
    expect(existsSync(join(projectDir, '.ok', 'templates', 'global.md'))).toBe(true);
  });

  test('writes a minimal-frontmatter template (title only — description optional)', () => {
    // Title is MUST; description is SHOULD (warning). With only title
    // set, write succeeds and serializes a single-block file with the identity
    // under the reserved `template:` key and no doc-frontmatter.
    const result = applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'minimal',
      body: 'just body',
      frontmatter: { title: 'Minimal' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const abs = join(projectDir, 'meetings', '.ok', 'templates', 'minimal.md');
    const content = readFileSync(abs, 'utf-8');
    expect(content).toContain('---\ntemplate:\n  title: Minimal\n---');
    expect(content).toContain('just body');
    // Description-missing warning fires.
    expect(result.warnings.some((w) => w.match(/description is missing/))).toBe(true);
  });

  test('rejects body frontmatter containing the reserved template: key', () => {
    // A top-level `template:` in the doc-frontmatter would collide with the
    // identity key in the composed single-block file and leak `template: {...}`
    // into every doc created from it.
    const result = applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'bad-reserved',
      body: '---\ntemplate:\n  title: Inner\nstatus: ok\n---\n# Body',
      frontmatter: { title: 'My Template', description: 'desc' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TEMPLATE_RESERVED_KEY');
  });
});

describe('applyTemplateDelete', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'tpl-del-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test('removes existing template + auto-cleans empty templates/ + .ok/', () => {
    applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'only',
      body: 'b',
      frontmatter: { title: 'Only', description: 'Only one' },
    });
    expect(existsSync(join(projectDir, 'meetings', '.ok', 'templates', 'only.md'))).toBe(true);

    const result = applyTemplateDelete({ projectDir, folder: 'meetings', name: 'only' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.existed).toBe(true);
    expect(result.cleanedEmpty.templatesDir).toBe(true);
    expect(result.cleanedEmpty.okDir).toBe(true);
    expect(existsSync(join(projectDir, 'meetings', '.ok'))).toBe(false);
  });

  test('idempotent: deleting non-existent template returns existed: false', () => {
    const result = applyTemplateDelete({ projectDir, folder: 'meetings', name: 'nonexistent' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.existed).toBe(false);
  });

  test('does NOT remove .ok/ when frontmatter.yml still lives there', () => {
    applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'tpl',
      body: 'b',
      frontmatter: { title: 'T', description: 'D' },
    });
    // Plant a frontmatter.yml so .ok/ has another tenant
    writeFileSync(join(projectDir, 'meetings', '.ok', 'frontmatter.yml'), 'tags: [meeting]\n');

    const result = applyTemplateDelete({ projectDir, folder: 'meetings', name: 'tpl' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cleanedEmpty.templatesDir).toBe(true);
    expect(result.cleanedEmpty.okDir).toBe(false);
    // .ok/ remains because frontmatter.yml is still there
    expect(existsSync(join(projectDir, 'meetings', '.ok', 'frontmatter.yml'))).toBe(true);
  });

  test('keeps siblings when removing one of multiple templates', () => {
    applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'prep',
      body: 'p',
      frontmatter: { title: 'Prep', description: 'd' },
    });
    applyTemplateWrite({
      projectDir,
      folder: 'meetings',
      name: 'post',
      body: 'p',
      frontmatter: { title: 'Post', description: 'd' },
    });

    applyTemplateDelete({ projectDir, folder: 'meetings', name: 'prep' });
    expect(existsSync(join(projectDir, 'meetings', '.ok', 'templates', 'prep.md'))).toBe(false);
    expect(existsSync(join(projectDir, 'meetings', '.ok', 'templates', 'post.md'))).toBe(true);
  });

  test('rejects bad name', () => {
    const result = applyTemplateDelete({ projectDir, folder: 'meetings', name: '../escape' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('BAD_NAME');
  });

  test('plants directories so we can verify cleanup edges', () => {
    // Make sure mkdirSync isn't unused-import bait
    mkdirSync(join(projectDir, 'sentinel'), { recursive: true });
    expect(existsSync(join(projectDir, 'sentinel'))).toBe(true);
  });
});

describe('applyTemplateMove', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'tpl-move-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  // Inject a plain fs rename for the relocation so the orchestration is tested
  // without a git repo. `false` mirrors the untracked / local-only path; the
  // server handler injects the git-mv variant.
  const fsRelocate = async (from: string, to: string) => {
    renameSync(from, to);
    return false;
  };

  function seed(folder: string, name: string, body = '# T') {
    applyTemplateWrite({ projectDir, folder, name, body, frontmatter: { title: 'T' } });
  }
  const tplPath = (folder: string, name: string) =>
    join(projectDir, folder, '.ok', 'templates', `${name}.md`);

  test('renames within the same folder', async () => {
    seed('research', 'a', '# A');
    const result = await applyTemplateMove({
      projectDir,
      fromFolder: 'research',
      fromName: 'a',
      toFolder: 'research',
      toName: 'b',
      relocate: fsRelocate,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.committed).toBe(false);
    expect(existsSync(tplPath('research', 'a'))).toBe(false);
    expect(existsSync(tplPath('research', 'b'))).toBe(true);
    expect(readFileSync(tplPath('research', 'b'), 'utf-8')).toContain('# A');
  });

  test('moves across folders and auto-cleans the emptied source .ok/', async () => {
    seed('research', 'scorecard');
    const result = await applyTemplateMove({
      projectDir,
      fromFolder: 'research',
      fromName: 'scorecard',
      toFolder: 'projects',
      toName: 'scorecard',
      relocate: fsRelocate,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(tplPath('projects', 'scorecard'))).toBe(true);
    // Source was the only template → templates/ and .ok/ are removed.
    expect(result.cleanedEmpty.templatesDir).toBe(true);
    expect(result.cleanedEmpty.okDir).toBe(true);
    expect(existsSync(join(projectDir, 'research', '.ok'))).toBe(false);
  });

  test('propagates committed=true from a git-mv relocator', async () => {
    seed('research', 'a');
    const result = await applyTemplateMove({
      projectDir,
      fromFolder: 'research',
      fromName: 'a',
      toFolder: 'research',
      toName: 'b',
      relocate: async (from, to) => {
        renameSync(from, to);
        return true;
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.committed).toBe(true);
  });

  test('404s when the source is absent (exact folder; inherited not resolved here)', async () => {
    seed('research', 'a'); // ancestor copy only
    const result = await applyTemplateMove({
      projectDir,
      fromFolder: 'research/sub',
      fromName: 'a',
      toFolder: 'research/sub',
      toName: 'b',
      relocate: fsRelocate,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TEMPLATE_NOT_FOUND');
  });

  test('409s when the destination already exists', async () => {
    seed('research', 'a');
    seed('research', 'b');
    const result = await applyTemplateMove({
      projectDir,
      fromFolder: 'research',
      fromName: 'a',
      toFolder: 'research',
      toName: 'b',
      relocate: fsRelocate,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TEMPLATE_EXISTS');
  });

  test('rejects a no-op move (same path)', async () => {
    seed('research', 'a');
    const result = await applyTemplateMove({
      projectDir,
      fromFolder: 'research',
      fromName: 'a',
      toFolder: 'research',
      toName: 'a',
      relocate: fsRelocate,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOOP');
  });

  test('rejects a traversal-escaping name', async () => {
    const result = await applyTemplateMove({
      projectDir,
      fromFolder: 'research',
      fromName: '../escape',
      toFolder: 'research',
      toName: 'b',
      relocate: fsRelocate,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('BAD_NAME');
  });
});

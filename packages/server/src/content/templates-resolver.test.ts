import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  resolveProjectTemplates,
  resolveTemplatesAvailable,
  type TemplateDirRefusalListener,
} from './templates-resolver.ts';

type TemplateDirRefusal = Parameters<TemplateDirRefusalListener>[0];

describe('resolveTemplatesAvailable', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'tpl-resolver-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  function writeTemplate(folder: string, name: string, body: string): void {
    const dir = join(projectDir, folder, '.ok', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), body);
  }

  function withFm(title: string, description: string, body = ''): string {
    return `---\ntitle: ${title}\ndescription: ${description}\n---\n${body}`;
  }

  test('returns empty when no .ok/templates/ exists anywhere', () => {
    expect(resolveTemplatesAvailable(projectDir, 'meetings')).toEqual([]);
    expect(resolveTemplatesAvailable(projectDir, '')).toEqual([]);
  });

  test('local templates: scope local at the target folder', () => {
    writeTemplate('meetings', 'prep-notes', withFm('Meeting Prep', 'Use before a meeting.'));
    writeTemplate('meetings', 'post-notes', withFm('Meeting Post', 'Use after a meeting.'));

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings');
    expect(tpls).toHaveLength(2);
    const names = tpls.map((t) => t.name).sort();
    expect(names).toEqual(['post-notes', 'prep-notes']);
    for (const t of tpls) {
      expect(t.scope).toBe('local');
      expect(t.source_folder).toBe('meetings');
    }
    const prep = tpls.find((t) => t.name === 'prep-notes');
    expect(prep?.title).toBe('Meeting Prep');
    expect(prep?.description).toBe('Use before a meeting.');
    expect(prep?.path).toBe('meetings/.ok/templates/prep-notes.md');
  });

  test('inherited templates: ancestor templates surface as scope inherited', () => {
    writeTemplate('meetings', 'prep-notes', withFm('Meeting Prep', 'Top-level prep.'));
    mkdirSync(join(projectDir, 'meetings', 'prep-notes'), { recursive: true });

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings/prep-notes');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]).toEqual({
      name: 'prep-notes',
      title: 'Meeting Prep',
      description: 'Top-level prep.',
      path: 'meetings/.ok/templates/prep-notes.md',
      source_folder: 'meetings',
      scope: 'inherited',
    });
  });

  test('closest wins on filename collision in the inheritance chain (D7)', () => {
    writeTemplate('meetings', 'prep-notes', withFm('Generic Prep', 'From meetings/.'));
    writeTemplate(
      'meetings/prep-notes',
      'prep-notes',
      withFm('Specific Prep', 'From prep-notes/.'),
    );

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings/prep-notes');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.title).toBe('Specific Prep');
    expect(tpls[0]?.scope).toBe('local');
    expect(tpls[0]?.source_folder).toBe('meetings/prep-notes');
  });

  test('siblings are NOT visible (scope rule)', () => {
    writeTemplate('meetings', 'prep-notes', withFm('Prep', 'For meetings.'));
    writeTemplate('research', 'research-log', withFm('Research', 'For research.'));

    const tpls = resolveTemplatesAvailable(projectDir, 'research');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.name).toBe('research-log');
    expect(tpls.find((t) => t.name === 'prep-notes')).toBeUndefined();
  });

  test('a non-directory ancestor .ok is skipped WITHOUT a refusal and the walk continues to the root', () => {
    writeTemplate('', 'global', withFm('Global', 'Survives the skip.'));
    mkdirSync(join(projectDir, 'anc', 'child'), { recursive: true });
    writeFileSync(join(projectDir, 'anc', '.ok'), 'not a directory\n');
    const refusals: TemplateDirRefusal[] = [];
    const tpls = resolveTemplatesAvailable(projectDir, 'anc/child', {
      onRefused: (r) => refusals.push(r),
    });
    expect(tpls.map((t) => t.name)).toEqual(['global']);
    expect(tpls[0]?.scope).toBe('inherited');
    expect(refusals).toEqual([]);
  });

  test('a regular FILE at .ok/templates is skipped WITHOUT a refusal and inherited templates still resolve', () => {
    writeTemplate('', 'global', withFm('Global', 'Survives the skip.'));
    mkdirSync(join(projectDir, 'flat', '.ok'), { recursive: true });
    writeFileSync(join(projectDir, 'flat', '.ok', 'templates'), 'not a directory\n');
    const refusals: TemplateDirRefusal[] = [];
    const tpls = resolveTemplatesAvailable(projectDir, 'flat', {
      onRefused: (r) => refusals.push(r),
    });
    expect(tpls.map((t) => t.name)).toEqual(['global']);
    expect(refusals).toEqual([]);
  });

  test('a self-referential symlink on the path reaches onRefused as unverifiable (no chmod needed)', () => {
    symlinkSync('loop', join(projectDir, 'loop'), 'dir');
    const refusals: TemplateDirRefusal[] = [];
    expect(
      resolveTemplatesAvailable(projectDir, 'loop', { onRefused: (r) => refusals.push(r) }),
    ).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      kind: 'unverifiable',
      folder: 'loop',
      component: '.ok/templates',
    });
    expect((refusals[0] as { code?: string }).code).toBe('ELOOP');
  });

  test('a symlinked ancestor .ok and a symlinked templates dir each reach onRefused, naming the folder', () => {
    mkdirSync(join(projectDir, 'target-a', 'templates'), { recursive: true });
    writeFileSync(join(projectDir, 'target-a', 'templates', 'x.md'), withFm('X', 'x'));
    mkdirSync(join(projectDir, 'a', 'child'), { recursive: true });
    symlinkSync('../target-a', join(projectDir, 'a', '.ok'), 'dir');
    mkdirSync(join(projectDir, 'target-b'), { recursive: true });
    writeFileSync(join(projectDir, 'target-b', 'y.md'), withFm('Y', 'y'));
    mkdirSync(join(projectDir, 'b', '.ok'), { recursive: true });
    symlinkSync('../../target-b', join(projectDir, 'b', '.ok', 'templates'), 'dir');

    writeTemplate('', 'global', withFm('Global', 'Survives the skip.'));
    const fromA: TemplateDirRefusal[] = [];
    const viaA = resolveTemplatesAvailable(projectDir, 'a/child', {
      onRefused: (r) => fromA.push(r),
    });
    expect(viaA.map((t) => t.name)).toEqual(['global']);
    expect(fromA).toEqual([{ kind: 'symlink', folder: 'a', component: '.ok' }]);

    const fromB: TemplateDirRefusal[] = [];
    const viaB = resolveTemplatesAvailable(projectDir, 'b', { onRefused: (r) => fromB.push(r) });
    expect(viaB.map((t) => t.name)).toEqual(['global']);
    expect(fromB).toEqual([{ kind: 'symlink', folder: 'b', component: '.ok/templates' }]);
  });

  test('an in-root symlinked ancestor .ok is not enumerated (menu matches fetch-by-name)', () => {
    mkdirSync(join(projectDir, 'secretdir', 'templates'), { recursive: true });
    writeFileSync(
      join(projectDir, 'secretdir', 'templates', 'note.md'),
      withFm('Hidden', 'Aliased through .ok'),
      'utf-8',
    );
    mkdirSync(join(projectDir, 'notes'), { recursive: true });
    symlinkSync('../secretdir', join(projectDir, 'notes', '.ok'), 'dir');
    mkdirSync(join(projectDir, 'notes', 'sub'), { recursive: true });
    writeTemplate('', 'global', withFm('Global', 'Survives the skip.'));

    expect(resolveTemplatesAvailable(projectDir, 'notes/sub').map((t) => t.name)).toEqual([
      'global',
    ]);
    expect(resolveTemplatesAvailable(projectDir, 'notes').map((t) => t.name)).toEqual(['global']);
  });

  test('an in-root symlinked templates dir is not enumerated', () => {
    mkdirSync(join(projectDir, 'elsewhere'), { recursive: true });
    writeFileSync(join(projectDir, 'elsewhere', 'x.md'), withFm('X', 'aliased'), 'utf-8');
    mkdirSync(join(projectDir, 'notes2', '.ok'), { recursive: true });
    symlinkSync('../../elsewhere', join(projectDir, 'notes2', '.ok', 'templates'), 'dir');
    writeTemplate('', 'global', withFm('Global', 'Survives the skip.'));

    expect(resolveTemplatesAvailable(projectDir, 'notes2').map((t) => t.name)).toEqual(['global']);
  });

  test('descendant templates do NOT surface in the parent folder (D17 — two-value scope)', () => {
    writeTemplate(
      'meetings/prep-notes',
      'agenda',
      withFm('Detailed Agenda', 'For larger meetings.'),
    );

    expect(resolveTemplatesAvailable(projectDir, 'meetings')).toEqual([]);

    const ownTpls = resolveTemplatesAvailable(projectDir, 'meetings/prep-notes');
    expect(ownTpls).toHaveLength(1);
    expect(ownTpls[0]?.name).toBe('agenda');
    expect(ownTpls[0]?.scope).toBe('local');
    expect(ownTpls[0]?.source_folder).toBe('meetings/prep-notes');
  });

  test('the resolver never descends into subfolders — only leaf→root ancestors', () => {
    writeTemplate('a/b/c', 'deep', withFm('Deep', 'Buried in a/b/c.'));

    expect(resolveTemplatesAvailable(projectDir, 'a')).toEqual([]);
    expect(resolveTemplatesAvailable(projectDir, 'a/b')).toEqual([]);

    const own = resolveTemplatesAvailable(projectDir, 'a/b/c');
    expect(own).toHaveLength(1);
    expect(own[0]?.name).toBe('deep');
    expect(own[0]?.scope).toBe('local');
  });

  test('templates without description still surface; title is required at write time but readable here without it (resolver tolerates legacy)', () => {
    writeTemplate('meetings', 'no-meta', '# Just a body\n');

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.name).toBe('no-meta');
    expect(tpls[0]?.title).toBeUndefined();
    expect(tpls[0]?.description).toBeUndefined();
    expect(tpls[0]?.scope).toBe('local');
  });

  test('frontmatter whose opening fence carries a trailing space still surfaces metadata', () => {
    writeTemplate(
      'meetings',
      'prep-notes',
      '--- \ntitle: Meeting Prep\ndescription: Use before a meeting.\n---\nbody\n',
    );

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.title).toBe('Meeting Prep');
    expect(tpls[0]?.description).toBe('Use before a meeting.');
  });

  test('frontmatter whose closing fence carries a trailing tab still surfaces metadata', () => {
    writeTemplate(
      'meetings',
      'prep-notes',
      '---\ntitle: Meeting Prep\ndescription: Use before a meeting.\n---\t\nbody\n',
    );

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.title).toBe('Meeting Prep');
    expect(tpls[0]?.description).toBe('Use before a meeting.');
  });

  test('an indented opening fence is not frontmatter (matches core recognition)', () => {
    writeTemplate('meetings', 'prep-notes', ' ---\ntitle: Nope\n---\nbody\n');

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.title).toBeUndefined();
    expect(tpls[0]?.description).toBeUndefined();
  });

  test('non-md files in templates/ are ignored', () => {
    writeTemplate('meetings', 'good', withFm('Good', 'OK'));
    const dir = join(projectDir, 'meetings', '.ok', 'templates');
    writeFileSync(join(dir, 'README.txt'), 'not a template');
    writeFileSync(join(dir, 'image.png'), 'fake png');

    const tpls = resolveTemplatesAvailable(projectDir, 'meetings');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.name).toBe('good');
  });

  test('project-root templates are inherited everywhere', () => {
    writeTemplate('', 'global', withFm('Global Template', 'Available everywhere.'));

    mkdirSync(join(projectDir, 'meetings', 'prep-notes'), { recursive: true });
    const tpls = resolveTemplatesAvailable(projectDir, 'meetings/prep-notes');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.name).toBe('global');
    expect(tpls[0]?.scope).toBe('inherited');
    expect(tpls[0]?.source_folder).toBe('');
  });

  test('malformed frontmatter is treated as no metadata, not an error', () => {
    const dir = join(projectDir, 'broken', '.ok', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.md'), '---\ntitle: [no closing\nbroken yaml\n---\nbody\n');

    const tpls = resolveTemplatesAvailable(projectDir, 'broken');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]?.name).toBe('broken');
    expect(tpls[0]?.title).toBeUndefined();
    expect(tpls[0]?.description).toBeUndefined();
  });

  test('a template symlinked outside the project root is dropped from the menu', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'tpl-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
      writeTemplate('notes', 'ok', withFm('OK', 'In-root template.'));
      const tplDir = join(projectDir, 'notes', '.ok', 'templates');
      symlinkSync(join(outside, 'secret.txt'), join(tplDir, 'leak.md'), 'file');

      const tpls = resolveTemplatesAvailable(projectDir, 'notes');
      expect(tpls.map((t) => t.name).sort()).toEqual(['ok']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a template symlinked to an in-root but out-of-templates path is dropped', () => {
    const okLocal = join(projectDir, '.ok', 'local');
    mkdirSync(okLocal, { recursive: true });
    writeFileSync(join(okLocal, 'last-spawn-error.log'), 'stack trace with secrets');
    writeTemplate('notes', 'ok', withFm('OK', 'In-root template.'));
    symlinkSync(
      join(okLocal, 'last-spawn-error.log'),
      join(projectDir, 'notes', '.ok', 'templates', 'leak.md'),
      'file',
    );

    const tpls = resolveTemplatesAvailable(projectDir, 'notes');
    expect(tpls.map((t) => t.name).sort()).toEqual(['ok']);
  });

  test('a templates DIRECTORY symlinked out of the project drops all its entries', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'tpl-dir-outside-'));
    try {
      writeFileSync(join(outside, 'leak.md'), withFm('Leak', 'Foreign template.'));
      mkdirSync(join(projectDir, 'notes', '.ok'), { recursive: true });
      symlinkSync(outside, join(projectDir, 'notes', '.ok', 'templates'), 'dir');
      writeTemplate('', 'global', withFm('Global', 'Survives the skip.'));

      expect(resolveTemplatesAvailable(projectDir, 'notes').map((t) => t.name)).toEqual(['global']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a templates DIRECTORY symlinked elsewhere IN-project is skipped wholesale', async () => {
    writeFileSync(join(projectDir, 'stash.md'), withFm('Stash', 'Not a template.'));
    mkdirSync(join(projectDir, 'notes', '.ok'), { recursive: true });
    symlinkSync(projectDir, join(projectDir, 'notes', '.ok', 'templates'), 'dir');
    writeTemplate('', 'global', withFm('Global', 'Survives the skip.'));

    expect(resolveTemplatesAvailable(projectDir, 'notes').map((t) => t.name)).toEqual(['global']);
  });
});

describe('resolveProjectTemplates', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'tpl-project-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  function writeTemplate(folder: string, name: string, body: string): void {
    const dir = folder
      ? join(projectDir, folder, '.ok', 'templates')
      : join(projectDir, '.ok', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), body);
  }

  function withFm(title: string, description: string): string {
    return `---\ntitle: ${title}\ndescription: ${description}\n---\nbody\n`;
  }

  test('returns flat list of every template across the project', async () => {
    writeTemplate('', 'daily-note', withFm('Daily note', 'Date-stamped log for today'));
    writeTemplate('meetings', 'meeting-notes', withFm('Meeting notes', 'Attendees, agenda, items'));
    writeTemplate('research', 'research-log', withFm('Research log', 'Working notes'));
    writeTemplate('specs', 'spec', withFm('Spec / RFC', 'Problem · proposal · decision'));

    const result = await resolveProjectTemplates(projectDir);
    const byName = Object.fromEntries(result.templates.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      'daily-note',
      'meeting-notes',
      'research-log',
      'spec',
    ]);
    expect(byName['daily-note']?.source_folder).toBe('');
    expect(byName['meeting-notes']?.source_folder).toBe('meetings');
    expect(byName['research-log']?.source_folder).toBe('research');
    expect(byName.spec?.source_folder).toBe('specs');
    expect(result.truncated).toBe(false);
  });

  test('templates in nested subfolders surface with their source_folder', async () => {
    writeTemplate('a/b/c', 'deep', withFm('Deep template', 'Buried in a/b/c'));
    const result = await resolveProjectTemplates(projectDir);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]?.source_folder).toBe('a/b/c');
    expect(result.templates[0]?.path).toBe('a/b/c/.ok/templates/deep.md');
  });

  test('skips node_modules, dist, build, and dot-prefixed dirs', async () => {
    writeTemplate('keep', 'visible', withFm('Visible', 'Should appear'));
    writeTemplate('node_modules/dep', 'hidden', withFm('Hidden', 'Should NOT appear'));
    writeTemplate('dist/output', 'hidden', withFm('Hidden', 'Should NOT appear'));
    writeTemplate('build/out', 'hidden', withFm('Hidden', 'Should NOT appear'));
    writeTemplate('.archive', 'hidden', withFm('Hidden', 'Dot-prefix excluded'));

    const result = await resolveProjectTemplates(projectDir);
    const folders = result.templates.map((t) => t.source_folder).sort();
    expect(folders).toEqual(['keep']);
  });

  test('walker terminates within PROJECT_TEMPLATE_SCAN_CAP — guards against pathological trees', async () => {
    writeTemplate('', 'visible-root', withFm('Root', 'At root'));
    writeTemplate('aa-early', 'visible-early', withFm('Early', 'Early in BFS'));
    for (let i = 0; i < 2100; i++) {
      mkdirSync(join(projectDir, `bulk-${i}`), { recursive: true });
    }
    const result = await resolveProjectTemplates(projectDir);
    expect(result.templates.some((t) => t.name === 'visible-root')).toBe(true);
    expect(result.templates.some((t) => t.name === 'visible-early')).toBe(true);
    expect(result.truncated).toBe(true);
  });

  test('returns empty array when no templates exist anywhere', async () => {
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    await expect(resolveProjectTemplates(projectDir)).resolves.toEqual({
      templates: [],
      truncated: false,
    });
  });

  test('every entry carries scope: local (no inheritance context in flat enumeration)', async () => {
    writeTemplate('', 'root-tpl', withFm('Root', 'At project root'));
    writeTemplate('subfolder', 'sub-tpl', withFm('Sub', 'In a subfolder'));
    const result = await resolveProjectTemplates(projectDir);
    expect(result.templates).toHaveLength(2);
    for (const t of result.templates) {
      expect(t.scope).toBe('local');
    }
  });

  test('descends through a symlinked directory', async () => {
    writeTemplate('real', 'linked-tpl', withFm('Linked', 'Behind a symlink'));
    symlinkSync(join(projectDir, 'real'), join(projectDir, 'alias'), 'dir');

    const result = await resolveProjectTemplates(projectDir);
    const folders = result.templates.map((t) => t.source_folder).sort();
    expect(folders).toEqual(['alias', 'real']);
    expect(result.templates.map((t) => t.path).sort()).toEqual([
      'alias/.ok/templates/linked-tpl.md',
      'real/.ok/templates/linked-tpl.md',
    ]);
  });

  test('a dangling symlink is skipped without aborting the walk', async () => {
    writeTemplate('real', 'survivor', withFm('Survivor', 'Must still surface'));
    symlinkSync(join(projectDir, 'no-such-target'), join(projectDir, 'dangling'), 'dir');

    const result = await resolveProjectTemplates(projectDir);
    expect(result.templates.map((t) => t.source_folder)).toEqual(['real']);
    expect(result.truncated).toBe(false);
  });

  test('every call re-walks, so a template written between scans surfaces', async () => {
    writeTemplate('', 'first', withFm('First', 'Present at first scan'));
    const before = await resolveProjectTemplates(projectDir);
    expect(before.templates.map((t) => t.name)).toEqual(['first']);

    writeTemplate('', 'second', withFm('Second', 'Added after the first scan'));
    const after = await resolveProjectTemplates(projectDir);
    expect(after.templates.map((t) => t.name).sort()).toEqual(['first', 'second']);
  });

  test('yields to the event loop while walking', async () => {
    for (let i = 0; i < 20; i++) {
      mkdirSync(join(projectDir, `dir-${i}`), { recursive: true });
    }
    let ticked = false;
    const pending = setImmediate(() => {
      ticked = true;
    });

    await resolveProjectTemplates(projectDir);
    clearImmediate(pending);

    expect(ticked).toBe(true);
  });

  test('a deleted template stops surfacing on the next call', async () => {
    writeTemplate('', 'doomed', withFm('Doomed', 'About to be removed'));
    const before = await resolveProjectTemplates(projectDir);
    expect(before.templates.map((t) => t.name)).toEqual(['doomed']);

    rmSync(join(projectDir, '.ok', 'templates', 'doomed.md'));
    const after = await resolveProjectTemplates(projectDir);
    expect(after.templates).toEqual([]);
  });
});

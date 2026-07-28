import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createEmptyFrontmatterSchemaFile,
  deleteFrontmatterSchemaFile,
  removeFrontmatterSchemaField,
  renameFrontmatterSchemaField,
  writeFrontmatterSchemaField,
} from './frontmatter-schema-write.ts';

let projectDir: string;
let outsideDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-fm-write-')));
  outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-fm-write-outside-')));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = join(projectDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

describe('writeFrontmatterSchemaField', () => {
  test('create-on-first-edit materializes the skeleton + edit at the mapped path', () => {
    const result = writeFrontmatterSchemaField(
      projectDir,
      '.ok/schemas/new.schema.json',
      'status',
      {
        enum: ['draft', 'review'],
        required: true,
      },
    );
    expect(result.action).toBe('created');
    const onDisk = JSON.parse(
      readFileSync(join(projectDir, '.ok/schemas/new.schema.json'), 'utf-8'),
    );
    expect(onDisk.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(onDisk.properties.status.enum).toEqual(['draft', 'review']);
    expect(onDisk.required).toEqual(['status']);
  });

  test('merge preserves advanced keywords on disk', () => {
    write(
      'schema.json',
      JSON.stringify({ type: 'object', allOf: [{ required: ['t'] }], 'x-k': 1 }, null, 2),
    );
    const result = writeFrontmatterSchemaField(projectDir, 'schema.json', 'owner', {
      type: 'string',
    });
    expect(result.action).toBe('written');
    const onDisk = JSON.parse(readFileSync(join(projectDir, 'schema.json'), 'utf-8'));
    expect(onDisk.allOf).toEqual([{ required: ['t'] }]);
    expect(onDisk['x-k']).toBe(1);
    expect(onDisk.properties.owner.type).toBe('string');
  });

  test('an escaping path is refused without writing', () => {
    const rel = `../${outsideDir.split('/').pop()}/evil.json`;
    const result = writeFrontmatterSchemaField(projectDir, rel, 'x', { type: 'string' });
    expect(result.action).toBe('refused');
  });

  test('a malformed existing schema is refused, file left untouched', () => {
    const abs = write('broken.json', '{ nope');
    const result = writeFrontmatterSchemaField(projectDir, 'broken.json', 'x', { type: 'string' });
    expect(result.action).toBe('refused');
    expect(readFileSync(abs, 'utf-8')).toBe('{ nope');
  });

  test('a no-op edit reports written without rewriting bytes', () => {
    write('same.json', `${JSON.stringify({ type: 'object' }, null, 2)}\n`);
    const before = readFileSync(join(projectDir, 'same.json'), 'utf-8');
    const result = writeFrontmatterSchemaField(projectDir, 'same.json', 'x', {});
    expect(result.action).toBe('written');
    expect(readFileSync(join(projectDir, 'same.json'), 'utf-8')).toBe(before);
  });
});

describe('createEmptyFrontmatterSchemaFile', () => {
  test('creates the draft-07 skeleton at a fresh path, making the dir', () => {
    const result = createEmptyFrontmatterSchemaFile(projectDir, '.ok/schemas/new.schema.json');
    expect(result.action).toBe('created');
    const onDisk = JSON.parse(
      readFileSync(join(projectDir, '.ok/schemas/new.schema.json'), 'utf-8'),
    );
    expect(onDisk).toMatchObject({ type: 'object' });
    expect(typeof onDisk.$schema).toBe('string');
  });

  test('is idempotent — an existing schema is left untouched (never clobbered)', () => {
    const existing = `${JSON.stringify({ type: 'object', properties: { a: { type: 'string' } } }, null, 2)}\n`;
    write('.ok/schemas/keep.json', existing);
    const result = createEmptyFrontmatterSchemaFile(projectDir, '.ok/schemas/keep.json');
    expect(result.action).toBe('written');
    expect(readFileSync(join(projectDir, '.ok/schemas/keep.json'), 'utf-8')).toBe(existing);
  });

  test('refuses a path that escapes the project root', () => {
    const rel = `../${outsideDir.split('/').pop()}/evil.json`;
    const result = createEmptyFrontmatterSchemaFile(projectDir, rel);
    expect(result.action).toBe('refused');
  });
});

describe('removeFrontmatterSchemaField / renameFrontmatterSchemaField', () => {
  const SEED = JSON.stringify(
    { type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: {} } },
    null,
    2,
  );

  test('remove drops the field on disk', () => {
    write('.ok/schemas/s.json', SEED);
    const result = removeFrontmatterSchemaField(projectDir, '.ok/schemas/s.json', 'a');
    expect(result.action).toBe('written');
    const onDisk = JSON.parse(readFileSync(join(projectDir, '.ok/schemas/s.json'), 'utf-8'));
    expect(onDisk.properties).toEqual({ b: {} });
    expect('required' in onDisk).toBe(false);
  });

  test('rename carries the property and required membership', () => {
    write('.ok/schemas/s.json', SEED);
    const result = renameFrontmatterSchemaField(projectDir, '.ok/schemas/s.json', 'a', 'z');
    expect(result.action).toBe('written');
    const onDisk = JSON.parse(readFileSync(join(projectDir, '.ok/schemas/s.json'), 'utf-8'));
    expect(Object.keys(onDisk.properties)).toEqual(['z', 'b']);
    expect(onDisk.required).toEqual(['z']);
  });

  test('a missing file is refused (no create-on-first-edit for these ops)', () => {
    expect(removeFrontmatterSchemaField(projectDir, 'gone.json', 'a').action).toBe('refused');
    expect(renameFrontmatterSchemaField(projectDir, 'gone.json', 'a', 'b').action).toBe('refused');
  });

  test('rename onto an existing field is refused, file untouched', () => {
    const abs = write('.ok/schemas/s.json', SEED);
    const result = renameFrontmatterSchemaField(projectDir, '.ok/schemas/s.json', 'a', 'b');
    expect(result.action).toBe('refused');
    expect(readFileSync(abs, 'utf-8')).toBe(SEED);
  });

  test('an escaping path is refused', () => {
    const rel = `../${outsideDir.split('/').pop()}/evil.json`;
    expect(removeFrontmatterSchemaField(projectDir, rel, 'a').action).toBe('refused');
  });
});

describe('deleteFrontmatterSchemaFile', () => {
  test('deletes an existing tool-managed schema file', () => {
    const abs = write('.ok/schemas/doc.schema.json', '{"type":"object"}');
    const result = deleteFrontmatterSchemaFile(projectDir, '.ok/schemas/doc.schema.json');
    expect(result.action).toBe('deleted');
    expect(existsSync(abs)).toBe(false);
  });

  test('is idempotent — an already-absent file still reports deleted', () => {
    const result = deleteFrontmatterSchemaFile(projectDir, '.ok/schemas/gone.schema.json');
    expect(result.action).toBe('deleted');
  });

  test('deletes a *.schema.json anywhere in the project', () => {
    const abs = write('docs/thing.schema.json', '{"type":"object"}');
    const result = deleteFrontmatterSchemaFile(projectDir, 'docs/thing.schema.json');
    expect(result.action).toBe('deleted');
    expect(existsSync(abs)).toBe(false);
  });

  test('refuses unconventionally named json outside .ok/schemas/, file left on disk', () => {
    const abs = write('schemas/user-owned.json', '{"type":"object"}');
    const result = deleteFrontmatterSchemaFile(projectDir, 'schemas/user-owned.json');
    expect(result.action).toBe('refused');
    expect(existsSync(abs)).toBe(true);
  });

  test('refuses a nested non-convention path under .ok/schemas/', () => {
    const abs = write('.ok/schemas/sub/nested.json', '{"type":"object"}');
    const result = deleteFrontmatterSchemaFile(projectDir, '.ok/schemas/sub/nested.json');
    expect(result.action).toBe('refused');
    expect(existsSync(abs)).toBe(true);
  });

  test('refuses traversal dressed as a schemas path', () => {
    const result = deleteFrontmatterSchemaFile(projectDir, '.ok/schemas/../../evil.json');
    expect(result.action).toBe('refused');
  });

  test('unlinks a symlink ENTRY without touching its target', () => {
    const target = write('kept.json', '{"type":"object"}');
    mkdirSync(join(projectDir, '.ok/schemas'), { recursive: true });
    const link = join(projectDir, '.ok/schemas/linked.json');
    symlinkSync(target, link);
    const result = deleteFrontmatterSchemaFile(projectDir, '.ok/schemas/linked.json');
    expect(result.action).toBe('deleted');
    expect(existsSync(link)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  test('refuses when .ok/schemas itself is a symlink escaping the project', () => {
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(outsideDir, 'victim.json'), '{"type":"object"}');
    symlinkSync(outsideDir, join(projectDir, '.ok/schemas'));
    const result = deleteFrontmatterSchemaFile(projectDir, '.ok/schemas/victim.json');
    expect(result.action).toBe('refused');
    expect(existsSync(join(outsideDir, 'victim.json'))).toBe(true);
  });

  test('a non-directory path component still reports deleted (provably absent)', () => {
    // `.ok` is a regular file, so resolving `.ok/schemas` fails with ENOTDIR.
    // The entry cannot exist, so `deleted` is the honest answer — this pins the
    // narrow branch against a naive "only ENOENT counts" rewrite.
    writeFileSync(join(projectDir, '.ok'), 'not a directory');
    const result = deleteFrontmatterSchemaFile(projectDir, '.ok/schemas/x.schema.json');
    expect(result.action).toBe('deleted');
  });
});

describe('write-path symlink containment', () => {
  test('refuses editing a schema symlinked outside the project, target untouched', () => {
    const victim = join(outsideDir, 'victim.json');
    const bytes = `${JSON.stringify({ type: 'object' }, null, 2)}\n`;
    writeFileSync(victim, bytes);
    symlinkSync(victim, join(projectDir, 'linked.schema.json'));
    const result = writeFrontmatterSchemaField(projectDir, 'linked.schema.json', 'status', {
      type: 'string',
    });
    expect(result.action).toBe('refused');
    expect(readFileSync(victim, 'utf-8')).toBe(bytes);
  });

  test('refuses remove/rename on a schema symlinked outside the project', () => {
    const victim = join(outsideDir, 'victim.json');
    const bytes = `${JSON.stringify({ type: 'object', required: ['a'], properties: { a: {} } }, null, 2)}\n`;
    writeFileSync(victim, bytes);
    symlinkSync(victim, join(projectDir, 'linked.schema.json'));
    expect(removeFrontmatterSchemaField(projectDir, 'linked.schema.json', 'a').action).toBe(
      'refused',
    );
    expect(renameFrontmatterSchemaField(projectDir, 'linked.schema.json', 'a', 'z').action).toBe(
      'refused',
    );
    expect(readFileSync(victim, 'utf-8')).toBe(bytes);
  });

  test('refuses creating under a .ok/schemas that symlinks outside the project', () => {
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    symlinkSync(outsideDir, join(projectDir, '.ok/schemas'));
    const created = createEmptyFrontmatterSchemaFile(projectDir, '.ok/schemas/new.schema.json');
    expect(created.action).toBe('refused');
    const edited = writeFrontmatterSchemaField(projectDir, '.ok/schemas/new.schema.json', 'x', {
      type: 'string',
    });
    expect(edited.action).toBe('refused');
    expect(existsSync(join(outsideDir, 'new.schema.json'))).toBe(false);
  });

  test('a symlink resolving INSIDE the project is edited in place', () => {
    const target = write('real/s.schema.json', `${JSON.stringify({ type: 'object' }, null, 2)}\n`);
    mkdirSync(join(projectDir, '.ok/schemas'), { recursive: true });
    symlinkSync(target, join(projectDir, '.ok/schemas/link.json'));
    const result = writeFrontmatterSchemaField(projectDir, '.ok/schemas/link.json', 'status', {
      type: 'string',
    });
    expect(result.action).toBe('written');
    const parsed = JSON.parse(readFileSync(target, 'utf-8')) as {
      properties: { status: { type: string } };
    };
    expect(parsed.properties.status.type).toBe('string');
  });
});

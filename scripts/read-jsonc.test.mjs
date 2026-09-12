import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJsoncOrError, stripJsonc } from './read-jsonc.mjs';

const withFile = (body, run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-jsonc-'));
  const file = path.join(dir, 'tsconfig.json');
  try {
    fs.writeFileSync(file, body);
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('stripJsonc', () => {
  it('drops line and block comments outside strings', () => {
    expect(
      JSON.parse(stripJsonc('{\n  // leading\n  "a": 1, /* inline */\n  "b": 2\n}\n')),
    ).toEqual({ a: 1, b: 2 });
  });

  it('keeps comment-shaped text that lives inside a string value', () => {
    expect(JSON.parse(stripJsonc('{ "a": "http://x/y", "b": "/* not a comment */" }'))).toEqual({
      a: 'http://x/y',
      b: '/* not a comment */',
    });
  });

  it('drops trailing commas in objects and arrays', () => {
    expect(JSON.parse(stripJsonc('{ "a": [1, 2, ], }'))).toEqual({ a: [1, 2] });
  });

  it('leaves a comma inside a string alone', () => {
    expect(JSON.parse(stripJsonc('{ "a": ",]" }'))).toEqual({ a: ',]' });
  });
});

describe('readJsoncOrError', () => {
  it('reads a commented tsconfig as the object it denotes', () => {
    const result = withFile(
      '{\n  // the base condition\n  "compilerOptions": { "customConditions": ["@inkeep/source"] },\n}\n',
      readJsoncOrError,
    );

    expect(result.ok).toBe(true);
    expect(result.value.compilerOptions.customConditions).toEqual(['@inkeep/source']);
  });

  it('separates a file that is not there from one that is malformed', () => {
    const absent = readJsoncOrError(path.join(os.tmpdir(), 'read-jsonc-absent', 'tsconfig.json'));
    expect(absent).toMatchObject({ ok: false, code: 'ENOENT' });
    expect(absent.reason).toContain('does not exist');

    const broken = withFile('{ "compilerOptions": ', readJsoncOrError);
    expect(broken).toMatchObject({ ok: false, code: 'EPARSE' });
    expect(broken.reason).toContain('malformed rather than merely commented');
  });
});

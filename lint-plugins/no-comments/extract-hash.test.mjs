import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  SHELL_MUST_FIRE,
  SHELL_MUST_NOT_FIRE,
  SHELL_SENTINEL,
} from './__fixtures__/hash-shapes.fixture.mjs';
import {
  extractHashComments,
  HASH_DIALECT_REGISTRY,
  hashDialectFor,
  hashDialectsWithoutReference,
  UnknownHashDialectError,
} from './extract-hash.mjs';
import { analyzeSource, loadPrecedentRegistry } from './index.mjs';

const shell = (source) => extractHashComments(source, { dialect: 'shell' });
const reportable = (source) => shell(source).filter((c) => c.kind === 'line');
const structural = (source) => shell(source).filter((c) => c.kind !== 'line');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRECEDENTS = loadPrecedentRegistry(REPO_ROOT);
const PYTHON_FAMILY = { extractor: 'hash-family', extensions: ['.py'] };

const pythonReported = (source) =>
  analyzeSource({
    source,
    relPath: 'tools/probe.py',
    precedentRegistry: PRECEDENTS,
    family: PYTHON_FAMILY,
  }).violations.map((violation) => violation.comment.text);

describe('the shell dialect never reads a hash that bash does not read as a comment', () => {
  test.each(SHELL_MUST_NOT_FIRE.map((f) => [`${f.id} ${f.label}`, f]))('%s', (_name, fixture) => {
    expect(shell(fixture.source).map((c) => c.text)).toEqual([SHELL_SENTINEL]);
  });

  test('the polarity is the one the evidence recorded', () => {
    expect(SHELL_MUST_NOT_FIRE).toHaveLength(22);
    expect(SHELL_MUST_NOT_FIRE.every((f) => f.source.endsWith(`${SHELL_SENTINEL}\n`))).toBe(true);
  });
});

describe('the shell dialect reads every hash that bash does read as a comment', () => {
  test.each(SHELL_MUST_FIRE.map((f) => [`${f.id} ${f.label}`, f]))('%s', (_name, fixture) => {
    expect(reportable(fixture.source).map((c) => c.text)).toEqual(fixture.comments);
    expect(structural(fixture.source).map((c) => c.text)).toEqual(fixture.structural ?? []);
  });

  test('the polarity is the one the evidence recorded', () => {
    expect(SHELL_MUST_FIRE).toHaveLength(11);
  });
});

describe('a hash comment carries the same span and position model as a slash comment', () => {
  test('offsets are exact and the text is the byte-exact span', () => {
    const source = 'echo one\necho two # trailing\n';
    const [comment] = reportable(source);
    expect(source.slice(comment.start, comment.end)).toBe('# trailing');
    expect(comment).toMatchObject({
      kind: 'line',
      text: '# trailing',
      line: 2,
      column: 10,
      precededByCode: true,
    });
  });

  test('a whole-line comment reports no preceding code', () => {
    expect(reportable('# alone\n')[0].precededByCode).toBe(false);
  });
});

describe('line one is structural, and only line one', () => {
  test('the shebang is its own kind, so no lane reports it as a comment', () => {
    expect(structural('#!/bin/sh\n# real\n').map((c) => c.kind)).toEqual(['shebang']);
  });

  test('a hash on line one that is not a shebang is an ordinary comment', () => {
    expect(structural('# plain\n')).toEqual([]);
    expect(reportable('# plain\n').map((c) => c.text)).toEqual(['# plain']);
  });

  test("python's coding cookie is structural on either of the lines PEP 263 allows", () => {
    const cookieFirst = extractHashComments('# -*- coding: utf-8 -*-\n# real\n', {
      dialect: 'python',
    });
    expect(cookieFirst.map((c) => c.kind)).toEqual(['coding-cookie', 'line']);

    const afterShebang = extractHashComments('#!/usr/bin/env python3\n# coding=latin-1\n# real\n', {
      dialect: 'python',
    });
    expect(afterShebang.map((c) => c.kind)).toEqual(['shebang', 'coding-cookie', 'line']);
  });

  test('a cookie on either line PEP 263 allows reaches no report, and the prose below it does', () => {
    expect(pythonReported('# -*- coding: utf-8 -*-\nimport os\n# narration\n')).toEqual([
      '# narration',
    ]);
    expect(
      pythonReported('#!/usr/bin/env python3\n# coding=latin-1\nimport os\n# narration\n'),
    ).toEqual(['# narration']);
  });

  test('a coding cookie on the third line is prose, not a cookie', () => {
    const late = extractHashComments('import os\nimport sys\n# coding: utf-8\n', {
      dialect: 'python',
    });
    expect(late.map((c) => c.kind)).toEqual(['line']);
  });

  test('a shell file gets no cookie rule, because no shell reads one', () => {
    expect(shell('# -*- coding: utf-8 -*-\n').map((c) => c.kind)).toEqual(['line']);
  });
});

describe('a dialect the extractor does not implement fails loud', () => {
  test('an unmapped extension names itself rather than defaulting to a grammar', () => {
    expect(() => hashDialectFor('config/app.toml')).toThrow(UnknownHashDialectError);
    expect(() => hashDialectFor('config/app.toml')).toThrow(/app\.toml/);
    expect(() => extractHashComments('# x\n', { dialect: 'toml' })).toThrow(
      UnknownHashDialectError,
    );
  });

  test('the dialects with a measured reference are mapped by extension', () => {
    expect(hashDialectFor('scripts/build.sh')).toBe('shell');
    expect(hashDialectFor('.github/workflows/ci.yml')).toBe('yaml');
    expect(hashDialectFor('.github/workflows/ci.yaml')).toBe('yaml');
  });

  test('python is mapped by extension though no reference measures it yet', () => {
    expect(hashDialectFor('tools/gen.py')).toBe('python');
  });

  test('an extensionless member resolves through the extensions its unit declares', () => {
    expect(hashDialectFor('.husky/pre-commit', { extensions: ['.sh'] })).toBe('shell');
    expect(() => hashDialectFor('.husky/pre-commit', { extensions: ['.sh', '.yml'] })).toThrow(
      UnknownHashDialectError,
    );
  });
});

describe('a dialect is measured only through a reference field it actually declares', () => {
  const lex = () => [];

  test('over the shipped table the unmeasured dialect is python and nothing else', () => {
    expect(hashDialectsWithoutReference(['.sh', '.yml', '.py'])).toStrictEqual(['python']);
  });

  test('a dialect entry written with no reference key at all reads as unmeasured', () => {
    expect(
      hashDialectsWithoutReference(['.sh'], { dialects: { shell: { structural: [], lex } } }),
    ).toStrictEqual(['shell']);
  });

  test('a reference recorded under a mistyped key is no reference', () => {
    expect(
      hashDialectsWithoutReference(['.yml'], {
        dialects: { yaml: { structural: [], lex, references: "the yaml package's CST" } },
      }),
    ).toStrictEqual(['yaml']);
  });

  test('every registered dialect declares the key, so an omission is caught where it is written', () => {
    expect(HASH_DIALECT_REGISTRY.length).toBeGreaterThan(0);
    expect(
      HASH_DIALECT_REGISTRY.filter((entry) => !entry.declaresReference).map(
        (entry) => entry.dialect,
      ),
    ).toStrictEqual([]);
  });
});

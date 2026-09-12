import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { DIRECTIVE_PATTERNS, directivesFor } from './allowlist.mjs';
import { extractComments } from './extract.mjs';
import { analyzeSource, loadPrecedentRegistry, UnknownFamilyError } from './index.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MODULE_DIR, '..', '..');
const PRECEDENTS = loadPrecedentRegistry(REPO_ROOT);

const analyze = (source, relPath) =>
  analyzeSource({ source, relPath, precedentRegistry: PRECEDENTS });

const reported = (source, relPath) =>
  analyze(source, relPath).comments.map((comment) => `${comment.kind}:${comment.text}`);

describe('the extractor is chosen by the family the config gives the path', () => {
  const SHELL = 'curl https://example.com/x # narration\n';

  test('shell source is read by the hash lexer, not by the slash lexer', () => {
    expect(
      analyze(SHELL, 'scripts/probe.sh').violations.map((v) => `${v.class}:${v.comment.text}`),
    ).toEqual(['prose:# narration']);
  });

  test('the slash lexer over the same bytes invents a URL comment and misses the real one', () => {
    expect(extractComments(SHELL, { jsx: false }).map((c) => c.text)).toEqual([
      '//example.com/x # narration',
    ]);
  });

  test('a path no family claims is named rather than read with a guessed grammar', () => {
    expect(() => analyze('# x\n', 'scripts/probe.toml')).toThrow(UnknownFamilyError);
    expect(() => analyze('# x\n', 'scripts/probe.toml')).toThrow(/probe\.toml/);
  });

  test('the shebang is extracted but never reported', () => {
    expect(reported('#!/usr/bin/env bash\n# narration\n', 'scripts/probe.sh')).toEqual([
      'line:# narration',
    ]);
  });
});

describe('directive registries are keyed by grammar family and file class', () => {
  const headlineOf = (registry, headline) =>
    registry.filter((entry) => entry.target === 'headline' && entry.regex.test(headline));

  test('the shell registry carries no ShellCheck shape, because nothing here runs ShellCheck', () => {
    expect(directivesFor('hash-family', 'shell')).toEqual([]);
    expect(headlineOf(directivesFor('hash-family', 'shell'), 'shellcheck disable=SC2086')).toEqual(
      [],
    );
  });

  test('the same probe finds a shape in the registry that does carry one', () => {
    expect(
      headlineOf(directivesFor('c-family', 'typescript'), 'biome-ignore lint/x: reason').map(
        (entry) => entry.id,
      ),
    ).toEqual(['biome-ignore']);
    expect(directivesFor('c-family', 'typescript')).toBe(DIRECTIVE_PATTERNS);
  });

  test('a ShellCheck directive in a shell file is prose', () => {
    expect(
      analyze('# shellcheck disable=SC2086\nrun $args\n', 'scripts/probe.sh').violations.map(
        (v) => v.class,
      ),
    ).toEqual(['prose']);
  });

  test('every declared file class resolves to a list, and an undeclared one is named', () => {
    expect(directivesFor('hash-family', 'yaml')).toEqual([]);
    expect(directivesFor('hash-family', 'python')).toEqual([]);
    expect(() => directivesFor('hash-family', 'toml')).toThrow(/toml/);
  });
});

describe('a hash marker run is one marker when its continuation is indented', () => {
  const classesOf = (source) =>
    analyze(source, 'scripts/probe.sh').kept.map((entry) => entry.class);

  test('an indented continuation joins the marker it heads', () => {
    const source = '# STOP: the caller owns the lock\n#   release it before returning\nrun\n';
    expect(classesOf(source)).toEqual(['contract-marker']);
    expect(analyze(source, 'scripts/probe.sh').violations).toEqual([]);
  });

  test('an unindented following line is a separate comment, and it is prose', () => {
    const source = '# STOP: the caller owns the lock\n# release it before returning\nrun\n';
    const { violations, kept } = analyze(source, 'scripts/probe.sh');
    expect(kept.map((entry) => entry.class)).toEqual(['contract-marker']);
    expect(violations.map((v) => v.class)).toEqual(['prose']);
  });

  test('the run keeps byte-exact spans, so a stripper deletes what it read', () => {
    const source = '# STOP: one\n#   two\nrun\n';
    const [marker] = analyze(source, 'scripts/probe.sh').kept;
    expect(source.slice(marker.comment.start, marker.comment.end)).toBe('# STOP: one\n#   two');
  });

  test('a run only forms under a marker head, never under plain prose', () => {
    const source = '# plain narration\n#   more narration\nrun\n';
    expect(analyze(source, 'scripts/probe.sh').violations.map((v) => v.class)).toEqual([
      'prose',
      'prose',
    ]);
  });

  test('slash comments keep the one-line marker rule they already had', () => {
    const source = '// STOP: the caller owns the lock\n//   release it before returning\nrun();\n';
    const { violations } = analyze(source, 'packages/app/src/probe.ts');
    expect(violations.map((v) => v.class)).toEqual(['prose']);
    expect(violations[0].fix).toMatch(/one line/);
  });
});

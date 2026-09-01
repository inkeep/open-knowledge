import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  decideSingleFileTarget,
  hasMarkdownExtension,
  isFileishTarget,
  resolveRootDispatch,
  scanRootArgv,
} from './single-file-dispatch.ts';

const SUBCOMMANDS = new Set([
  'start',
  'init',
  'mcp',
  'ui',
  'open',
  'ps',
  'status',
  'stop',
  'clean',
]);

function isFileishWith(existing: Set<string>): (t: string) => boolean {
  return (t) => hasMarkdownExtension(t) || existing.has(t);
}

describe('scanRootArgv', () => {
  test('collects positional operands, strips global options', () => {
    expect(scanRootArgv(['notes.md']).operands).toEqual(['notes.md']);
    expect(scanRootArgv(['--no-color', 'notes.md']).operands).toEqual(['notes.md']);
    expect(scanRootArgv(['--log-level', 'debug', 'notes.md']).operands).toEqual(['notes.md']);
    expect(scanRootArgv(['--log-level=debug', 'notes.md']).operands).toEqual(['notes.md']);
    expect(scanRootArgv(['open', 'doc']).operands).toEqual(['open', 'doc']);
  });

  test('extracts --cwd (space + equals form), consuming its value', () => {
    expect(scanRootArgv(['--cwd', '/foo', 'notes.md']).cwd).toBe('/foo');
    expect(scanRootArgv(['--cwd=/bar', 'notes.md']).cwd).toBe('/bar');
    expect(scanRootArgv(['--cwd', '/foo', 'notes.md']).operands).toEqual(['notes.md']);
  });

  test('help/version flags short-circuit to terminal (passthrough to Commander)', () => {
    expect(scanRootArgv(['--help']).sawTerminalFlag).toBe(true);
    expect(scanRootArgv(['-h']).sawTerminalFlag).toBe(true);
    expect(scanRootArgv(['--version']).sawTerminalFlag).toBe(true);
    expect(scanRootArgv(['-V']).sawTerminalFlag).toBe(true);
    expect(scanRootArgv(['notes.md']).sawTerminalFlag).toBe(false);
  });
});

describe('decideSingleFileTarget', () => {
  const opts = (existing: string[] = []) => ({
    knownSubcommands: SUBCOMMANDS,
    isFileish: isFileishWith(new Set(existing)),
  });

  test('a .md / .mdx operand routes to single-file open', () => {
    expect(decideSingleFileTarget(['notes.md'], opts())).toBe('notes.md');
    expect(decideSingleFileTarget(['./a/b.mdx'], opts())).toBe('./a/b.mdx');
  });

  test('an existing file (no markdown ext) routes to single-file open', () => {
    expect(decideSingleFileTarget(['README'], opts(['README']))).toBe('README');
  });

  test('a known subcommand is left for Commander (passthrough)', () => {
    expect(decideSingleFileTarget(['start'], opts())).toBeNull();
    expect(decideSingleFileTarget(['init'], opts())).toBeNull();
    expect(decideSingleFileTarget(['start'], opts(['start']))).toBeNull();
  });

  test('`ok open <file>` (fileish 2nd operand) routes to single-file open of that file', () => {
    expect(decideSingleFileTarget(['open', 'notes.md'], opts())).toBe('notes.md');
    expect(decideSingleFileTarget(['open', './start'], opts(['./start']))).toBe('./start');
  });

  test('`ok open <ext-less doc>` is left to the existing `ok open` subcommand', () => {
    expect(decideSingleFileTarget(['open', 'specs/foo/SPEC'], opts())).toBeNull();
  });

  test('no operand → passthrough', () => {
    expect(decideSingleFileTarget([], opts())).toBeNull();
  });

  test('a non-fileish first operand → passthrough (Commander reports unknown command)', () => {
    expect(decideSingleFileTarget(['totally-unknown'], opts())).toBeNull();
  });
});

describe('hasMarkdownExtension', () => {
  test('matches .md / .mdx case-insensitively only at the end', () => {
    expect(hasMarkdownExtension('notes.md')).toBe(true);
    expect(hasMarkdownExtension('notes.MDX')).toBe(true);
    expect(hasMarkdownExtension('notes.markdown')).toBe(false);
    expect(hasMarkdownExtension('md')).toBe(false);
    expect(hasMarkdownExtension('a.md.txt')).toBe(false);
  });
});

describe('isFileishTarget (fs-backed predicate)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-fileish-'));
    writeFileSync(join(dir, 'note.md'), '# note');
    writeFileSync(join(dir, 'data.json'), '{}');
    mkdirSync(join(dir, 'a-folder'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('a markdown-extension token is fileish (even if it does not exist)', () => {
    expect(isFileishTarget(join(dir, 'missing.md'), 'missing.md')).toBe(true);
  });

  test('an existing regular file is fileish', () => {
    expect(isFileishTarget(join(dir, 'data.json'), 'data.json')).toBe(true);
    expect(isFileishTarget(join(dir, 'note.md'), 'note.md')).toBe(true);
  });

  test('an existing DIRECTORY is NOT fileish — so `ok open <folder>` falls through to the open command', () => {
    expect(isFileishTarget(join(dir, 'a-folder'), 'a-folder')).toBe(false);
  });

  test('a non-existent non-markdown token is not fileish', () => {
    expect(isFileishTarget(join(dir, 'nope'), 'nope')).toBe(false);
  });
});

describe('--project override matrix', () => {
  const ROOT = '/abs/project';
  const combos: Array<{ name: string; argv: string[]; fileTarget: string | null }> = [
    {
      name: 'space syntax, flag before target, with extension',
      argv: ['open', '--project', ROOT, 'notes.md'],
      fileTarget: '/base/notes.md',
    },
    {
      name: 'space syntax, flag after target, with extension',
      argv: ['open', 'notes.md', '--project', ROOT],
      fileTarget: '/base/notes.md',
    },
    {
      name: 'equals syntax, flag before target, with extension',
      argv: ['open', `--project=${ROOT}`, 'notes.md'],
      fileTarget: '/base/notes.md',
    },
    {
      name: 'equals syntax, flag after target, with extension',
      argv: ['open', 'notes.md', `--project=${ROOT}`],
      fileTarget: '/base/notes.md',
    },
    {
      name: 'space syntax, flag before target, no extension',
      argv: ['open', '--project', ROOT, 'notes'],
      fileTarget: null,
    },
    {
      name: 'space syntax, flag after target, no extension',
      argv: ['open', 'notes', '--project', ROOT],
      fileTarget: null,
    },
    {
      name: 'equals syntax, flag before target, no extension',
      argv: ['open', `--project=${ROOT}`, 'notes'],
      fileTarget: null,
    },
    {
      name: 'equals syntax, flag after target, no extension',
      argv: ['open', 'notes', `--project=${ROOT}`],
      fileTarget: null,
    },
  ];

  for (const combo of combos) {
    test(`${combo.name} → project root is carried, never an operand`, () => {
      const scanned = scanRootArgv(combo.argv);
      expect(scanned.project).toBe(ROOT);
      expect(scanned.operands).not.toContain(ROOT);

      const dispatch = resolveRootDispatch(combo.argv, {
        knownSubcommands: SUBCOMMANDS,
        cwd: '/base',
        isFileish: (_abs, token) => hasMarkdownExtension(token),
        resolvePath: (base, token) => (token.startsWith('/') ? token : `${base}/${token}`),
      });

      if (combo.fileTarget === null) {
        expect(dispatch).toBeNull();
        expect(scanned.operands).toEqual(['open', 'notes']);
      } else {
        expect(dispatch).toEqual({ absPath: combo.fileTarget, projectRoot: ROOT });
      }
    });
  }

  test('a bare `ok <file> --project <dir>` carries the override too', () => {
    const dispatch = resolveRootDispatch(['notes.md', '--project', ROOT], {
      knownSubcommands: SUBCOMMANDS,
      cwd: '/base',
      isFileish: (_abs, token) => hasMarkdownExtension(token),
      resolvePath: (base, token) => (token.startsWith('/') ? token : `${base}/${token}`),
    });
    expect(dispatch).toEqual({ absPath: '/base/notes.md', projectRoot: ROOT });
  });

  test('no override → null project root (ancestor walk decides)', () => {
    const dispatch = resolveRootDispatch(['notes.md'], {
      knownSubcommands: SUBCOMMANDS,
      cwd: '/base',
      isFileish: (_abs, token) => hasMarkdownExtension(token),
      resolvePath: (base, token) => (token.startsWith('/') ? token : `${base}/${token}`),
    });
    expect(dispatch).toEqual({ absPath: '/base/notes.md', projectRoot: null });
  });

  test('--scope value is not mistaken for an operand', () => {
    expect(scanRootArgv(['open', '--skill', '--scope', 'user', 'my-skill']).operands).toEqual([
      'open',
      'my-skill',
    ]);
  });

  test('help/version still short-circuits the dispatch', () => {
    expect(
      resolveRootDispatch(['--help', 'notes.md'], {
        knownSubcommands: SUBCOMMANDS,
        cwd: '/base',
        isFileish: () => true,
        resolvePath: (base, token) => `${base}/${token}`,
      }),
    ).toBeNull();
  });
});

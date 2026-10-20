import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  freshSlotResidue,
  parseServerResetResidue,
  serverResetResidueProblems,
} from '../stress/_helpers/reuse/fresh-slot.ts';

const FIXTURE_DOCS = ['test-doc', 'sidebar-folder/nested-doc'] as const;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, text = ''): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, 'utf-8');
}

function freshSlot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-fresh-slot-')));
  roots.push(root);
  write(root, 'test-doc.md');
  write(root, 'sidebar-folder/nested-doc.md');
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(root, '.ok', 'skills'), { recursive: true });
  write(root, '.ok/local/cache/main/backlinks.json', '{}');
  write(root, '.ok/local/cache/tags.json', '{}');
  write(root, '.ok/local/principal.json', '{}');
  write(root, '.ok/local/server.lock', '{}');
  write(root, '.ok/local/state.json', '{}');
  write(root, '.ok/local/acp-registry-cache.json', '{}');
  write(root, '.ok/local/stale-external-writes.json', '{}');
  write(root, '.ok/local/receipts.jsonl', '');
  write(root, '.ok/local/removed-docs.json', '{}');
  write(root, '.git/HEAD', 'ref: refs/heads/main\n');
  return root;
}

describe('a reset slot is compared with what a freshly booted server holds', () => {
  test('the tree a freshly booted test server writes has no residue', () => {
    expect(freshSlotResidue(freshSlot(), FIXTURE_DOCS)).toEqual([]);
  });

  test('saved settings of every scope are residue', () => {
    const root = freshSlot();
    write(root, '.ok/config.yml', 'content: {}\n');
    write(root, '.ok/local/config.yml', 'search: {}\n');
    write(root, '.ok/global.yml', 'appearance:\n  theme: dark\n');
    write(root, '.ok/themes/mine.yaml', 'scheme: mine\n');

    expect(freshSlotResidue(root, FIXTURE_DOCS)).toEqual([
      '.ok/config.yml is not in a freshly booted slot',
      '.ok/global.yml is not in a freshly booted slot',
      '.ok/local/config.yml is not in a freshly booted slot',
      '.ok/themes is not in a freshly booted slot',
    ]);
  });

  test('created content, edited fixture documents and missing fixtures are residue', () => {
    const root = freshSlot();
    write(root, 'created.md', '# made by a test\n');
    write(root, 'test-doc.md', 'edited\n');
    write(root, 'sidebar-folder/extra.md', '');
    rmSync(join(root, 'sidebar-folder', 'nested-doc.md'));
    rmSync(join(root, '.claude', 'skills'), { recursive: true });

    expect(freshSlotResidue(root, FIXTURE_DOCS)).toEqual([
      '.claude/skills is missing',
      'created.md is not in a freshly booted slot',
      'sidebar-folder/extra.md is not in a freshly booted slot',
      'sidebar-folder/nested-doc.md is missing',
      'test-doc.md is not empty',
    ]);
  });

  test('an installed skill and a non-empty ignore file are residue while an empty ignore file is not', () => {
    const root = freshSlot();
    write(root, '.okignore', '');
    expect(freshSlotResidue(root, FIXTURE_DOCS)).toEqual([]);

    write(root, '.okignore', 'drafts/\n');
    write(root, '.claude/skills/helper/SKILL.md', '---\nname: helper\n---\n');
    expect(freshSlotResidue(root, FIXTURE_DOCS)).toEqual([
      '.claude/skills/helper is not in a freshly booted slot',
      '.okignore is not empty',
    ]);
  });

  test('a symlink where the slot expects a directory or file is residue', () => {
    const root = freshSlot();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ok-fresh-slot-elsewhere-')));
    roots.push(elsewhere);
    rmSync(join(root, 'sidebar-folder'), { recursive: true });
    symlinkSync(elsewhere, join(root, 'sidebar-folder'));
    rmSync(join(root, 'test-doc.md'));
    symlinkSync(join(elsewhere, 'missing.md'), join(root, 'test-doc.md'));

    expect(freshSlotResidue(root, FIXTURE_DOCS)).toEqual([
      'sidebar-folder is not a directory',
      'test-doc.md is not a file',
    ]);
  });
});

describe('the server reset report', () => {
  test('a report naming nothing left behind has no problems', () => {
    const residue = parseServerResetResidue({
      scope: 'server',
      residue: {
        loadedDocuments: [],
        clientConnections: 0,
        agentSessions: 0,
        agentPresence: [],
        staleExternalWrites: [],
        removedDocuments: [],
      },
    });

    expect(serverResetResidueProblems(residue)).toEqual([]);
  });

  test('documents, connections, sessions and presence the server kept are each named', () => {
    const residue = parseServerResetResidue({
      scope: 'server',
      residue: {
        loadedDocuments: ['notes'],
        clientConnections: 2,
        agentSessions: 1,
        agentPresence: ['agent-a'],
        staleExternalWrites: ['drafts/plan'],
        removedDocuments: ['old-notes'],
      },
    });

    expect(serverResetResidueProblems(residue)).toEqual([
      'loaded documents notes',
      '2 client connections',
      '1 agent sessions',
      'agent presence for agent-a',
      'stale external writes for drafts/plan',
      'removal records for old-notes',
    ]);
  });

  test('a residue field this check does not inspect is rejected, so leftover state of a new kind discards the slot', () => {
    expect(() =>
      parseServerResetResidue({
        scope: 'server',
        residue: {
          loadedDocuments: [],
          clientConnections: 0,
          agentSessions: 0,
          agentPresence: [],
          staleExternalWrites: [],
          removedDocuments: [],
          watchedFolders: ['drafts'],
        },
      }),
    ).toThrow(
      'the test-reset response residue reports watchedFolders, which this check does not inspect',
    );
  });

  test('a body that is not a server-scope report is rejected', () => {
    expect(() => parseServerResetResidue({})).toThrow(
      'the test-reset response is not a server-scope report',
    );
    expect(() =>
      parseServerResetResidue({
        scope: 'server',
        residue: { loadedDocuments: 'notes', clientConnections: 0, agentSessions: 0 },
      }),
    ).toThrow('the test-reset response residue.loadedDocuments is not a list of strings');
  });
});

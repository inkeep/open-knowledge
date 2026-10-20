import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type SlotEntry =
  | { readonly kind: 'empty-file'; readonly required: boolean }
  | { readonly kind: 'directory'; readonly required: boolean; readonly entries: SlotTree }
  | { readonly kind: 'server-owned' };

type SlotTree = Readonly<Record<string, SlotEntry>>;

const SERVER_OWNED: SlotEntry = { kind: 'server-owned' };

function directory(required: boolean, entries: SlotTree = {}): SlotEntry {
  return { kind: 'directory', required, entries };
}

const SERVER_WRITTEN_TREE: SlotTree = {
  '.git': SERVER_OWNED,
  '.okignore': { kind: 'empty-file', required: false },
  '.claude': directory(true, { skills: directory(true) }),
  '.ok': directory(false, {
    skills: directory(false),
    local: directory(false, {
      'acp-registry-cache.json': SERVER_OWNED,
      cache: SERVER_OWNED,
      'principal.json': SERVER_OWNED,
      'receipts.jsonl': SERVER_OWNED,
      'removed-docs.json': SERVER_OWNED,
      'server.lock': SERVER_OWNED,
      'stale-external-writes.json': SERVER_OWNED,
      'state.json': SERVER_OWNED,
    }),
  }),
};

function withFixtureDoc(tree: SlotTree, segments: readonly string[]): SlotTree {
  const [head, ...rest] = segments;
  if (head === undefined) return tree;
  if (rest.length === 0) return { ...tree, [`${head}.md`]: { kind: 'empty-file', required: true } };
  const existing = tree[head];
  const entries = existing?.kind === 'directory' ? existing.entries : {};
  return { ...tree, [head]: directory(true, withFixtureDoc(entries, rest)) };
}

function freshSlotTree(fixtureDocNames: readonly string[]): SlotTree {
  return fixtureDocNames.reduce(
    (tree, docName) => withFixtureDoc(tree, docName.split('/')),
    SERVER_WRITTEN_TREE,
  );
}

function compare(root: string, relative: string, tree: SlotTree, problems: string[]): void {
  const present = new Set<string>();
  for (const name of readdirSync(join(root, relative))) {
    present.add(name);
    const path = relative === '' ? name : `${relative}/${name}`;
    const expected = tree[name];
    if (expected === undefined) {
      problems.push(`${path} is not in a freshly booted slot`);
      continue;
    }
    if (expected.kind === 'server-owned') continue;
    const stat = lstatSync(join(root, path));
    if (expected.kind === 'empty-file') {
      if (!stat.isFile()) problems.push(`${path} is not a file`);
      else if (stat.size > 0) problems.push(`${path} is not empty`);
      continue;
    }
    if (!stat.isDirectory()) {
      problems.push(`${path} is not a directory`);
      continue;
    }
    compare(root, path, expected.entries, problems);
  }
  for (const [name, expected] of Object.entries(tree)) {
    if (expected.kind === 'server-owned' || !expected.required || present.has(name)) continue;
    problems.push(`${relative === '' ? name : `${relative}/${name}`} is missing`);
  }
}

export function freshSlotResidue(
  contentDir: string,
  fixtureDocNames: readonly string[],
): readonly string[] {
  const problems: string[] = [];
  compare(contentDir, '', freshSlotTree(fixtureDocNames), problems);
  return problems.sort();
}

export interface ServerResetResidue {
  readonly loadedDocuments: readonly string[];
  readonly clientConnections: number;
  readonly agentSessions: number;
  readonly agentPresence: readonly string[];
  readonly staleExternalWrites: readonly string[];
  readonly removedDocuments: readonly string[];
}

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(fields: Fields, key: string): readonly string[] {
  const value = fields[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new TypeError(`the test-reset response residue.${key} is not a list of strings`);
  }
  return value;
}

function count(fields: Fields, key: string): number {
  const value = fields[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`the test-reset response residue.${key} is not a non-negative integer`);
  }
  return value;
}

const RESIDUE_FIELDS: ReadonlySet<string> = new Set([
  'loadedDocuments',
  'clientConnections',
  'agentSessions',
  'agentPresence',
  'staleExternalWrites',
  'removedDocuments',
] satisfies readonly (keyof ServerResetResidue)[]);

export function parseServerResetResidue(body: unknown): ServerResetResidue {
  if (!isFields(body) || body.scope !== 'server' || !isFields(body.residue)) {
    throw new TypeError('the test-reset response is not a server-scope report');
  }
  const { residue } = body;
  const uninspected = Object.keys(residue).filter((key) => !RESIDUE_FIELDS.has(key));
  if (uninspected.length > 0) {
    throw new TypeError(
      `the test-reset response residue reports ${uninspected.join(', ')}, which this check does not inspect`,
    );
  }
  return {
    loadedDocuments: stringList(residue, 'loadedDocuments'),
    clientConnections: count(residue, 'clientConnections'),
    agentSessions: count(residue, 'agentSessions'),
    agentPresence: stringList(residue, 'agentPresence'),
    staleExternalWrites: stringList(residue, 'staleExternalWrites'),
    removedDocuments: stringList(residue, 'removedDocuments'),
  };
}

export function serverResetResidueProblems(residue: ServerResetResidue): readonly string[] {
  const problems: string[] = [];
  if (residue.loadedDocuments.length > 0) {
    problems.push(`loaded documents ${residue.loadedDocuments.join(', ')}`);
  }
  if (residue.clientConnections > 0) {
    problems.push(`${residue.clientConnections} client connections`);
  }
  if (residue.agentSessions > 0) problems.push(`${residue.agentSessions} agent sessions`);
  if (residue.agentPresence.length > 0) {
    problems.push(`agent presence for ${residue.agentPresence.join(', ')}`);
  }
  if (residue.staleExternalWrites.length > 0) {
    problems.push(`stale external writes for ${residue.staleExternalWrites.join(', ')}`);
  }
  if (residue.removedDocuments.length > 0) {
    problems.push(`removal records for ${residue.removedDocuments.join(', ')}`);
  }
  return problems;
}

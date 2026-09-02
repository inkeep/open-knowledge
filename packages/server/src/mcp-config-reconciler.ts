import { classifyMcpLauncherEntry, type McpLauncherDescriptor } from '@inkeep/open-knowledge-core';
import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  type Node as JsonNode,
  modify,
  type ParseError,
  parseTree,
} from 'jsonc-parser';

const MAX_CONFIG_BYTES = 10 * 1024 * 1024;

export const TRACKED_MCP_CONFIG_TARGETS = [
  '.mcp.json',
  '.cursor/mcp.json',
  '.codex/config.toml',
  'opencode.json',
] as const;

type TrackedMcpConfigTarget = (typeof TRACKED_MCP_CONFIG_TARGETS)[number];

export interface RawMcpConfigLayers {
  readonly base: string | null;
  readonly head: string | null;
  readonly index: string | null;
  readonly worktree: string | null;
  readonly incoming: string | null;
}

export interface NativeTomlMcpEditor {
  parseToObject(raw: string): Record<string, unknown>;
  removeEntry(raw: string, serverName: string): { text: string; existed: boolean };
  upsertEntry(
    raw: string,
    serverName: string,
    entry: Record<string, unknown>,
  ): { text: string; existed: boolean };
}

type McpConfigReconcileDeclineReason =
  | 'unsupported-target'
  | 'oversize'
  | 'unparseable'
  | 'duplicate-container'
  | 'no-native-writer'
  | 'no-entry'
  | 'foreign-entry'
  | 'mixed-launcher-family'
  | 'file-deletion-ambiguity'
  | 'entry-deletion-ambiguity'
  | 'index-worktree-divergence'
  | 'merge-base-unavailable'
  | 'unowned-shell-conflict';

export type McpConfigReconcilePlan =
  | {
      kind: 'resolved';
      raw: string;
      winner: McpLauncherDescriptor;
      winnerEntry: Record<string, unknown>;
    }
  | { kind: 'unchanged' }
  | { kind: 'declined'; reason: McpConfigReconcileDeclineReason };

interface TargetShape {
  readonly format: 'json' | 'toml';
  readonly topLevelKey: 'mcpServers' | 'mcp_servers' | 'mcp';
  readonly managedKeys: readonly string[];
}

interface ClassifiedRaw {
  readonly raw: string;
  readonly shell: string;
  readonly entry: Record<string, unknown>;
  readonly descriptor: McpLauncherDescriptor;
}

type RawClassification =
  | { kind: 'absent' }
  | { kind: 'no-entry'; raw: string; shell: string }
  | ({ kind: 'managed' } & ClassifiedRaw)
  | { kind: 'declined'; reason: McpConfigReconcileDeclineReason };

const TARGET_SHAPES: Record<TrackedMcpConfigTarget, TargetShape> = {
  '.mcp.json': { format: 'json', topLevelKey: 'mcpServers', managedKeys: ['command', 'args'] },
  '.cursor/mcp.json': {
    format: 'json',
    topLevelKey: 'mcpServers',
    managedKeys: ['command', 'args'],
  },
  '.codex/config.toml': {
    format: 'toml',
    topLevelKey: 'mcp_servers',
    managedKeys: ['command', 'args'],
  },
  'opencode.json': { format: 'json', topLevelKey: 'mcp', managedKeys: ['type', 'command'] },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function targetShape(target: string): TargetShape | null {
  return Object.hasOwn(TARGET_SHAPES, target)
    ? TARGET_SHAPES[target as TrackedMcpConfigTarget]
    : null;
}

function splitBom(raw: string): { bom: string; body: string } {
  return raw.charCodeAt(0) === 0xfeff
    ? { bom: '\uFEFF', body: raw.slice(1) }
    : { bom: '', body: raw };
}

function formattingOptions(raw: string): {
  insertSpaces: boolean;
  tabSize: number;
  eol: string;
} {
  const indent = raw.match(/\n([ \t]+)["}]/)?.[1] ?? '  ';
  return {
    insertSpaces: !indent.includes('\t'),
    tabSize: indent.includes('\t') ? 1 : Math.max(1, indent.length),
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
  };
}

function countRootProperties(root: JsonNode, key: string): number {
  if (root.type !== 'object') return 0;
  return (root.children ?? []).filter(
    (property) => property.type === 'property' && property.children?.[0]?.value === key,
  ).length;
}

function normalizeNativeTomlResult(source: string, edited: string): string {
  const { bom, body } = splitBom(source);
  const crlf = (body.match(/\r\n/g)?.length ?? 0) > (body.match(/(?<!\r)\n/g)?.length ?? 0);
  const trailingNewline = body.endsWith('\n');
  let normalized = edited.replace(/\r\n/g, '\n');
  normalized = trailingNewline
    ? `${normalized.replace(/\n+$/, '')}\n`
    : normalized.replace(/\n+$/, '');
  if (crlf) normalized = normalized.replace(/\n/g, '\r\n');
  return `${bom}${normalized}`;
}

function classifyJson(raw: string, shape: TargetShape): RawClassification {
  const { bom, body } = splitBom(raw);
  const errors: ParseError[] = [];
  const root = parseTree(body, errors, { allowTrailingComma: true, disallowComments: false });
  if (!root || errors.length > 0 || root.type !== 'object') {
    return { kind: 'declined', reason: 'unparseable' };
  }
  if (countRootProperties(root, shape.topLevelKey) > 1) {
    return { kind: 'declined', reason: 'duplicate-container' };
  }
  const entryPath = [shape.topLevelKey, 'open-knowledge'];
  const entryNode = findNodeAtLocation(root, entryPath);
  if (!entryNode) return { kind: 'no-entry', raw, shell: raw };
  const entry = getNodeValue(entryNode) as unknown;
  if (!isRecord(entry)) return { kind: 'declined', reason: 'foreign-entry' };
  const launcher = classifyMcpLauncherEntry(entry);
  if (launcher.kind === 'declined') return { kind: 'declined', reason: 'foreign-entry' };

  let shellBody = body;
  const managedNodes = shape.managedKeys
    .map((key) => ({ key, node: findNodeAtLocation(root, [...entryPath, key]) }))
    .filter((item): item is { key: string; node: JsonNode } => item.node !== undefined)
    .sort((left, right) => right.node.offset - left.node.offset);
  for (const { key, node } of managedNodes) {
    const sentinel = JSON.stringify(managedFieldSentinel(shape, key));
    shellBody = `${shellBody.slice(0, node.offset)}${sentinel}${shellBody.slice(node.offset + node.length)}`;
  }
  const shell = `${bom}${shellBody}`;
  return { kind: 'managed', raw, shell, entry, descriptor: launcher.descriptor };
}

function managedFieldSentinel(shape: TargetShape, key: string): unknown {
  if (shape.topLevelKey === 'mcp' && key === 'type') return '__ok_managed_type__';
  if (key === 'command' && shape.topLevelKey === 'mcp') return ['__ok_managed_command__'];
  if (key === 'command') return '__ok_managed_command__';
  return ['__ok_managed_args__'];
}

function classifyToml(
  raw: string,
  shape: TargetShape,
  editor: NativeTomlMcpEditor | undefined,
): RawClassification {
  if (!editor) return { kind: 'declined', reason: 'no-native-writer' };
  const { bom, body } = splitBom(raw);
  let parsed: Record<string, unknown>;
  try {
    parsed = editor.parseToObject(body);
  } catch {
    return { kind: 'declined', reason: 'unparseable' };
  }
  const container = parsed[shape.topLevelKey];
  const entry = isRecord(container) ? container['open-knowledge'] : undefined;
  if (entry === undefined) return { kind: 'no-entry', raw, shell: raw };
  if (!isRecord(entry)) return { kind: 'declined', reason: 'foreign-entry' };
  const launcher = classifyMcpLauncherEntry(entry);
  if (launcher.kind === 'declined') return { kind: 'declined', reason: 'foreign-entry' };
  let masked: { text: string; existed: boolean };
  try {
    masked = editor.upsertEntry(
      body,
      'open-knowledge',
      Object.fromEntries(shape.managedKeys.map((key) => [key, managedFieldSentinel(shape, key)])),
    );
  } catch {
    return { kind: 'declined', reason: 'unparseable' };
  }
  const shell = normalizeNativeTomlResult(raw, masked.text);
  return { kind: 'managed', raw: `${bom}${body}`, shell, entry, descriptor: launcher.descriptor };
}

function classifyRaw(
  raw: string | null,
  shape: TargetShape,
  editor: NativeTomlMcpEditor | undefined,
): RawClassification {
  if (raw === null) return { kind: 'absent' };
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) {
    return { kind: 'declined', reason: 'oversize' };
  }
  return shape.format === 'json' ? classifyJson(raw, shape) : classifyToml(raw, shape, editor);
}

function upsertJsonManagedFields(
  raw: string,
  shape: TargetShape,
  entry: Record<string, unknown>,
): string {
  const { bom, body } = splitBom(raw);
  let edited = body;
  for (const key of shape.managedKeys) {
    const currentRoot = parseTree(edited, [], {
      allowTrailingComma: true,
      disallowComments: false,
    });
    const currentNode = currentRoot
      ? findNodeAtLocation(currentRoot, [shape.topLevelKey, 'open-knowledge', key])
      : undefined;
    if (currentNode && JSON.stringify(getNodeValue(currentNode)) === JSON.stringify(entry[key])) {
      continue;
    }
    edited = applyEdits(
      edited,
      modify(edited, [shape.topLevelKey, 'open-knowledge', key], entry[key], {
        formattingOptions: formattingOptions(body),
      }),
    );
  }
  return `${bom}${edited}`;
}

function upsertManagedFields(
  raw: string,
  shape: TargetShape,
  entry: Record<string, unknown>,
  editor: NativeTomlMcpEditor | undefined,
): string | null {
  if (shape.format === 'json') return upsertJsonManagedFields(raw, shape, entry);
  if (!editor) return null;
  const { body } = splitBom(raw);
  const managedEntry = Object.fromEntries(shape.managedKeys.map((key) => [key, entry[key]]));
  try {
    return normalizeNativeTomlResult(
      raw,
      editor.upsertEntry(body, 'open-knowledge', managedEntry).text,
    );
  } catch {
    return null;
  }
}

export function applyManagedMcpEntry(input: {
  target: string;
  raw: string;
  entry: Record<string, unknown>;
  tomlEditor?: NativeTomlMcpEditor;
}): string | null {
  const shape = targetShape(input.target);
  if (!shape) return null;
  return upsertManagedFields(input.raw, shape, input.entry, input.tomlEditor);
}

export function getMcpUnownedShell(input: {
  target: string;
  raw: string;
  tomlEditor?: NativeTomlMcpEditor;
}): string | null {
  const shape = targetShape(input.target);
  if (!shape) return null;
  const classified = classifyRaw(input.raw, shape, input.tomlEditor);
  return classified.kind === 'managed' || classified.kind === 'no-entry' ? classified.shell : null;
}

function chooseShell(
  base: ClassifiedRaw,
  worktree: ClassifiedRaw,
  incoming: ClassifiedRaw,
): string | null {
  if (worktree.shell === incoming.shell) return worktree.shell;
  if (worktree.shell === base.shell) return incoming.shell;
  if (incoming.shell === base.shell) return worktree.shell;
  return null;
}

export function reconcileTrackedMcpConfig(input: {
  target: string;
  layers: RawMcpConfigLayers;
  runningEntry?: Record<string, unknown>;
  tomlEditor?: NativeTomlMcpEditor;
}): McpConfigReconcilePlan {
  const shape = targetShape(input.target);
  if (!shape) return { kind: 'declined', reason: 'unsupported-target' };

  const classified = {
    base: classifyRaw(input.layers.base, shape, input.tomlEditor),
    head: classifyRaw(input.layers.head, shape, input.tomlEditor),
    index: classifyRaw(input.layers.index, shape, input.tomlEditor),
    worktree: classifyRaw(input.layers.worktree, shape, input.tomlEditor),
    incoming: classifyRaw(input.layers.incoming, shape, input.tomlEditor),
  };
  const states = Object.values(classified);
  const declined = states.find((state) => state.kind === 'declined');
  if (declined?.kind === 'declined') return declined;
  if (states.some((state) => state.kind === 'absent')) {
    return states.every((state) => state.kind === 'absent')
      ? { kind: 'unchanged' }
      : { kind: 'declined', reason: 'file-deletion-ambiguity' };
  }
  if (states.some((state) => state.kind === 'no-entry')) {
    return states.every((state) => state.kind === 'no-entry')
      ? { kind: 'declined', reason: 'no-entry' }
      : { kind: 'declined', reason: 'entry-deletion-ambiguity' };
  }

  const managed = classified as Record<keyof RawMcpConfigLayers, ClassifiedRaw>;
  if (managed.index.shell !== managed.worktree.shell) {
    return { kind: 'declined', reason: 'index-worktree-divergence' };
  }
  const shell = chooseShell(managed.base, managed.worktree, managed.incoming);
  if (shell === null) return { kind: 'declined', reason: 'unowned-shell-conflict' };

  const candidates = Object.values(managed).map((state) => ({
    entry: state.entry,
    descriptor: state.descriptor,
  }));
  if (input.runningEntry) {
    const running = classifyMcpLauncherEntry(input.runningEntry);
    if (running.kind === 'recognized') {
      candidates.push({ entry: input.runningEntry, descriptor: running.descriptor });
    }
  }
  const families = new Set(candidates.map((candidate) => candidate.descriptor.family));
  if (families.size !== 1) return { kind: 'declined', reason: 'mixed-launcher-family' };
  const winner = candidates.reduce((best, candidate) =>
    candidate.descriptor.revision > best.descriptor.revision ? candidate : best,
  );

  const shellSource = [
    managed.worktree,
    managed.index,
    managed.head,
    managed.incoming,
    managed.base,
  ].find((state) => state.shell === shell);
  if (!shellSource) return { kind: 'declined', reason: 'unowned-shell-conflict' };
  const raw = upsertManagedFields(shellSource.raw, shape, winner.entry, input.tomlEditor);
  if (raw === null) {
    return {
      kind: 'declined',
      reason: input.tomlEditor ? 'unparseable' : 'no-native-writer',
    };
  }
  return {
    kind: 'resolved',
    raw,
    winner: winner.descriptor,
    winnerEntry: winner.entry,
  };
}

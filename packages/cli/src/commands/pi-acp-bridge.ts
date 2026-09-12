import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  PiBridgeWriteAction,
  PiTrustWriteAction,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { atomicWriteFileSync } from '@inkeep/open-knowledge-core/server';
import { buildPiExtensionSource, isOwnPiManagedFileEntry } from '../integrations/pi-extension.ts';
import {
  type ConfigFileDeclineReason,
  configFileDeclineDetail,
  configFileDeclineReason,
} from '../utils/config-file-error.ts';
import { escapeDisplayPath } from '../utils/escape-display-path.ts';
import { isObject } from '../utils/is-object.ts';
import {
  EDITOR_TARGETS,
  isEntryUpToDate,
  type McpInstallOptions,
  resolvePiAgentDirPath,
} from './editors.ts';
import { classifyExistingMcpEntry, writeEditorMcpConfig } from './init.ts';
import { existingFileMode } from './jsonc-surgical.ts';
import {
  commitPiTrustGrant,
  forgetPiTrustGrant,
  listPiTrustGrants,
  type PiTrustGrantReceipt,
  PiTrustReceiptError,
  preparePiTrustGrant,
} from './pi-trust-grants.ts';
import { withPiTrustLock, withPiTrustLockSync } from './pi-trust-lock.ts';
import { inspectPiTrustResources } from './pi-trust-resources.ts';
import { resolveRemovalFilePath } from './removal-file-path.ts';

const PI_TRUST_FILENAME = 'trust.json';

export type PiBridgeFileState = 'absent' | 'own-current' | 'own-stale' | 'foreign' | 'unreadable';

export type PiTrustState = 'trusted' | 'untrusted' | 'unreadable';

export type PiBridgeState = {
  cwd: string;
  bridgePath: string;
  trustPath: string;
} & (
  | { project: 'unavailable'; error: string }
  | {
      project: 'ready';
      canonicalCwd: string;
      bridge: PiBridgeFileState;
      trust: PiTrustState;
      bridgeLoadable: boolean;
      otherExtensions: readonly string[];
    }
);

export type { PiBridgeWriteAction, PiTrustWriteAction };

type PiTrustRemoveResult =
  | { action: 'removed' | 'not-present'; error?: never; detail?: never }
  | { action: 'kept-shared' | 'kept-unowned'; detail: string; error?: never }
  | { action: 'kept-unverified' | 'refused-unreadable' | 'failed'; error: string; detail?: never };

export type PiTrustRemoveAction = PiTrustRemoveResult['action'];

export interface EnsurePiBridgeResult {
  ok: boolean;
  cwd: string;
  bridgePath: string;
  trustPath: string;
  bridge: PiBridgeWriteAction;
  trust: PiTrustWriteAction;
  error?: string;
}

function resolvePiPaths(
  cwd: string,
  home?: string,
  env?: NodeJS.ProcessEnv,
): {
  cwd: string;
  bridgePath: string;
  trustPath: string;
} {
  const normalizedCwd = resolve(cwd);
  const agentDir = resolvePiAgentDirPath({
    home,
    env: env ?? (home === undefined ? process.env : {}),
  });
  return {
    cwd: normalizedCwd,
    bridgePath: EDITOR_TARGETS.pi.projectConfigPath(normalizedCwd),
    trustPath: join(agentDir, PI_TRUST_FILENAME),
  };
}

type PiProjectPath = { path: string; canonical: string };

function resolvePiProjectPath(
  path: string,
): { kind: 'ready'; project: PiProjectPath } | { kind: 'refused'; error: string } {
  try {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) {
      return {
        kind: 'refused',
        error: `Pi project path ${escapeDisplayPath(path)} is not a directory; restore the intended project directory, then retry`,
      };
    }
    accessSync(canonical, constants.X_OK);
    return { kind: 'ready', project: { path, canonical } };
  } catch (error) {
    return {
      kind: 'refused',
      error: `Pi project directory ${escapeDisplayPath(path)} could not be resolved or accessed: ${escapeDisplayPath(error instanceof Error ? error.message : String(error))}; restore the directory or symlink and check its permissions, then retry`,
    };
  }
}

function recheckPiProjectPath(project: PiProjectPath): string | undefined {
  const checked = resolvePiProjectPath(project.path);
  if (checked.kind === 'refused') return checked.error;
  if (checked.project.canonical !== project.canonical) {
    return `Pi project path ${escapeDisplayPath(project.path)} changed while waiting for its trust lock; restore the intended project location, then retry`;
  }
  return undefined;
}

function classifyPiBridgeFile(
  cwd: string,
  bridgePath: string,
  home: string | undefined,
): { state: PiBridgeFileState; text: string | null } {
  const classified = classifyExistingMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePath);
  if (classified.kind === 'absent') return { state: 'absent', text: null };
  if (classified.kind !== 'present') return { state: 'unreadable', text: null };
  const entry = classified.entry;
  const text =
    Array.isArray(entry.args) && typeof entry.args[0] === 'string' ? entry.args[0] : null;
  if (isEntryUpToDate(entry)) return { state: 'own-current', text };
  if (isOwnPiManagedFileEntry(entry)) return { state: 'own-stale', text };
  return { state: 'foreign', text };
}

type PiTrustReadResult =
  | {
      state: 'trusted' | 'untrusted';
      entries: Record<string, unknown>;
      trailingNewline: boolean;
    }
  | { state: 'unreadable'; reason: ReturnType<typeof configFileDeclineReason> | 'invalid-json' };

function readPiTrust(
  file: Extract<PiTrustFilePath, { path: string }>,
  cwd: string,
): PiTrustReadResult {
  let raw: string;
  try {
    raw = readFileSync(file.path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (file.kind === 'missing' && code === 'ENOENT') {
      return { state: 'untrusted', entries: {}, trailingNewline: false };
    }
    return { state: 'unreadable', reason: configFileDeclineReason(err) };
  }
  if (raw.trim() === '') return { state: 'untrusted', entries: {}, trailingNewline: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'unreadable', reason: 'invalid-json' };
  }
  if (!isObject(parsed)) return { state: 'unreadable', reason: 'invalid-json' };
  return {
    state: parsed[cwd] === true ? 'trusted' : 'untrusted',
    entries: parsed,
    trailingNewline: raw.endsWith('\n'),
  };
}

type PiTrustFilePath =
  | { kind: 'ready' | 'missing'; path: string }
  | { kind: 'refused'; error: string };

type PiTrustRefusalReason =
  | ConfigFileDeclineReason
  | 'invalid-json'
  | 'path-changed'
  | 'unavailable-root';

function piTrustRefusalDetail(reason: PiTrustRefusalReason): string {
  switch (reason) {
    case 'invalid-json':
      return 'the file is not a valid JSON object; repair its JSON, then retry';
    case 'path-changed':
      return 'the path changed while waiting for its lock; retry to check its current state';
    case 'unavailable-root':
      return 'the filesystem root is unavailable; reconnect the drive or network share, then retry';
    default:
      return configFileDeclineDetail(reason);
  }
}

function refusedTrustPath(
  trustPath: string,
  reason: PiTrustRefusalReason,
): Extract<PiTrustFilePath, { kind: 'refused' }> {
  return {
    kind: 'refused',
    error: `trust store ${escapeDisplayPath(trustPath)}: ${piTrustRefusalDetail(reason)}`,
  };
}

function resolvePiTrustFilePath(trustPath: string): PiTrustFilePath {
  const resolved = resolveRemovalFilePath(trustPath);
  try {
    switch (resolved.kind) {
      case 'declined':
        return refusedTrustPath(trustPath, resolved.reason);
      case 'ready':
        return { kind: 'ready', path: realpathSync(resolved.path) };
      case 'not-present':
        break;
      default: {
        const exhaustive: never = resolved;
        throw new Error(`unhandled trust file resolution: ${exhaustive}`);
      }
    }
    let parent = dirname(trustPath);
    const suffix = [basename(trustPath)];
    let parentEntry = lstatSync(parent, { throwIfNoEntry: false });
    while (!parentEntry) {
      const ancestor = dirname(parent);
      if (ancestor === parent) return refusedTrustPath(trustPath, 'unavailable-root');
      suffix.unshift(basename(parent));
      parent = ancestor;
      parentEntry = lstatSync(parent, { throwIfNoEntry: false });
    }
    try {
      return { kind: 'missing', path: join(realpathSync(parent), ...suffix) };
    } catch (error) {
      return refusedTrustPath(
        trustPath,
        parentEntry.isSymbolicLink() && (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'missing-symlink-target'
          : configFileDeclineReason(error),
      );
    }
  } catch (error) {
    return refusedTrustPath(trustPath, configFileDeclineReason(error));
  }
}

function recheckPiTrustFilePath(
  trustPath: string,
  previous: Extract<PiTrustFilePath, { path: string }>,
): PiTrustFilePath {
  const current = resolvePiTrustFilePath(trustPath);
  if (current.kind === 'refused') return current;
  if (current.path !== previous.path || (previous.kind === 'ready' && current.kind === 'missing')) {
    return refusedTrustPath(trustPath, 'path-changed');
  }
  return current;
}

export function probePiBridgeState(
  cwd: string,
  home?: string,
  env?: NodeJS.ProcessEnv,
): PiBridgeState {
  const paths = resolvePiPaths(cwd, home, env);
  const project = resolvePiProjectPath(paths.cwd);
  if (project.kind === 'refused') {
    return { ...paths, project: 'unavailable', error: project.error };
  }
  const bridge = classifyPiBridgeFile(paths.cwd, paths.bridgePath, home).state;
  const trustFile = resolvePiTrustFilePath(paths.trustPath);
  const trust =
    trustFile.kind === 'refused'
      ? 'unreadable'
      : trustFile.kind === 'missing'
        ? 'untrusted'
        : readPiTrust(trustFile, project.project.canonical).state;
  return {
    ...paths,
    project: 'ready',
    canonicalCwd: project.project.canonical,
    bridge,
    trust,
    bridgeLoadable: (bridge === 'own-current' || bridge === 'own-stale') && trust === 'trusted',
    otherExtensions: listOtherPiExtensions(paths.bridgePath).displayNames,
  };
}

function listOtherPiExtensions(bridgePath: string): {
  displayNames: readonly string[];
} {
  const dir = dirname(bridgePath);
  const own = basename(bridgePath);
  try {
    return {
      displayNames: readdirSync(dir)
        .filter((name) => name !== own && name.endsWith('.ts'))
        .sort()
        .map((name) => escapeDisplayPath(JSON.stringify(name))),
    };
  } catch {
    return { displayNames: [] };
  }
}

export async function ensurePiBridge(
  cwd: string,
  options: McpInstallOptions = { mode: 'published' },
  home?: string,
  env?: NodeJS.ProcessEnv,
  approvedCanonicalCwd?: string,
): Promise<EnsurePiBridgeResult> {
  const base = resolvePiPaths(cwd, home, env);
  const project = resolvePiProjectPath(base.cwd);
  if (project.kind === 'refused') {
    return {
      ...base,
      ok: false,
      bridge: 'refused-project-path',
      trust: 'skipped',
      error: project.error,
    };
  }
  if (approvedCanonicalCwd !== undefined && project.project.canonical !== approvedCanonicalCwd) {
    return {
      ...base,
      ok: false,
      bridge: 'refused-project-path',
      trust: 'skipped',
      error: `The approved Pi project directory ${escapeDisplayPath(approvedCanonicalCwd)} no longer matches the current directory ${escapeDisplayPath(project.project.canonical)}. Reopen the intended project and approve the Pi integration again; no bridge or trust settings were changed.`,
    };
  }
  const existing = classifyPiBridgeFile(base.cwd, base.bridgePath, home);

  if (existing.state === 'foreign') {
    return { ...base, ok: false, bridge: 'refused-foreign', trust: 'skipped' };
  }
  if (existing.state === 'unreadable') {
    return { ...base, ok: false, bridge: 'refused-unreadable', trust: 'skipped' };
  }

  let bridge: PiBridgeWriteAction;
  if (existing.state === 'absent') {
    bridge = 'written';
  } else {
    let desired: string | undefined;
    try {
      desired = buildPiExtensionSource(options);
    } catch {
      desired = undefined;
    }
    bridge = desired !== undefined && existing.text === desired ? 'unchanged' : 'refreshed';
  }

  if (bridge !== 'unchanged') {
    const result = writeEditorMcpConfig(
      EDITOR_TARGETS.pi,
      base.cwd,
      options,
      home,
      base.bridgePath,
    );
    if (result.action !== 'written' && result.action !== 'overwritten') {
      return {
        ...base,
        ok: false,
        bridge: 'failed',
        trust: 'skipped',
        error:
          result.error !== undefined
            ? escapeDisplayPath(result.error)
            : `bridge write ${result.action}`,
      };
    }
  }

  const trust = await addPiTrustEntry(base.trustPath, project.project, home ?? homedir());
  return {
    ...base,
    ok: trust.action === 'already-trusted' || trust.action === 'added',
    bridge,
    trust: trust.action,
    ...(trust.error !== undefined ? { error: trust.error } : {}),
  };
}

async function addPiTrustEntry(
  trustPath: string,
  project: PiProjectPath,
  home: string,
): Promise<{ action: PiTrustWriteAction; error?: string }> {
  const cwd = project.canonical;
  const resolved = resolvePiTrustFilePath(trustPath);
  if (resolved.kind === 'refused') return { action: 'refused-unreadable', error: resolved.error };
  try {
    mkdirSync(dirname(resolved.path), { recursive: true });
  } catch (err) {
    return {
      action: 'failed',
      error: escapeDisplayPath(err instanceof Error ? err.message : String(err)),
    };
  }
  const captured: { action: PiTrustWriteAction; error?: string } = { action: 'added' };
  try {
    await withPiTrustLock(trustPath, resolved.path, () => {
      const projectError = recheckPiProjectPath(project);
      if (projectError) {
        captured.action = 'refused-unreadable';
        captured.error = projectError;
        return;
      }
      const checked = recheckPiTrustFilePath(trustPath, resolved);
      if (checked.kind === 'refused') {
        captured.action = 'refused-unreadable';
        captured.error = checked.error;
        return;
      }
      const current = readPiTrust(checked, cwd);
      if (current.state === 'trusted') {
        captured.action = 'already-trusted';
        return;
      }
      if (current.state === 'unreadable') {
        captured.action = 'refused-unreadable';
        captured.error = refusedTrustPath(trustPath, current.reason).error;
        return;
      }
      const receipt = accessPiTrustReceipts(home, () => {
        const previousReceipt = listPiTrustGrants(home, cwd).find(
          (grant) => grant.record.canonicalTrustPath === checked.path,
        );
        if (previousReceipt) forgetPiTrustGrant(home, previousReceipt);
        return preparePiTrustGrant(
          home,
          cwd,
          trustPath,
          checked.path,
          Object.hasOwn(current.entries, cwd)
            ? { present: true, value: current.entries[cwd] }
            : { present: false },
        );
      });
      const next = { ...current.entries, [cwd]: true };
      const serialized = JSON.stringify(next, null, 2) + (current.trailingNewline ? '\n' : '');
      const mode = existingFileMode(checked.path);
      atomicWriteFileSync(checked.path, serialized, mode !== undefined ? { mode } : undefined);
      accessPiTrustReceipts(home, () => commitPiTrustGrant(home, receipt));
      captured.action = 'added';
    });
  } catch (err) {
    return {
      action: 'failed',
      error: escapeDisplayPath(err instanceof Error ? err.message : String(err)),
    };
  }
  return captured;
}

function missingPiProjectPathCandidate(path: string): string | undefined {
  const suffix: string[] = [];
  let inspecting = path;
  try {
    while (true) {
      const entry = lstatSync(inspecting, { throwIfNoEntry: false });
      if (entry) {
        if (suffix.length === 0) return undefined;
        const ancestor = realpathSync(inspecting);
        if (!statSync(ancestor).isDirectory()) return undefined;
        accessSync(ancestor, constants.X_OK);
        return join(ancestor, ...suffix);
      }
      const parent = dirname(inspecting);
      if (parent === inspecting) return undefined;
      suffix.unshift(basename(inspecting));
      inspecting = parent;
    }
  } catch {
    return undefined;
  }
}

type PiTrustRemovalKey = {
  cwd: string;
  mode: 'recorded' | 'inspect';
  receipt?: PiTrustGrantReceipt;
};

type PiTrustRemovalStore = {
  trustPath: string;
  resolved: Extract<PiTrustFilePath, { path: string }>;
  keys: Map<string, PiTrustRemovalKey>;
};

function aggregatePiTrustRemoval(outcomes: readonly PiTrustRemoveResult[]): PiTrustRemoveResult {
  const priority = {
    'not-present': 0,
    removed: 1,
    'kept-unowned': 2,
    'kept-shared': 3,
    'kept-unverified': 4,
    'refused-unreadable': 5,
    failed: 6,
  } satisfies Record<PiTrustRemoveAction, number>;
  const outcome = outcomes.reduce<PiTrustRemoveResult>(
    (best, item) => (priority[item.action] > priority[best.action] ? item : best),
    { action: 'not-present' },
  );
  const errors = outcomes.flatMap((item) => item.error ?? []);
  const details = outcomes.flatMap((item) => item.detail ?? []);
  if (errors.length > 0) {
    return {
      action: outcome.error !== undefined ? outcome.action : 'failed',
      error: [...errors, ...details].join('\n'),
    };
  }
  if (outcome.detail !== undefined) return { ...outcome, detail: details.join('\n') };
  return outcome;
}

export function removePiTrustEntry(
  cwd: string,
  home?: string,
  env?: NodeJS.ProcessEnv,
  options: { recordedOnly?: boolean } = {},
): PiTrustRemoveResult {
  const base = resolvePiPaths(cwd, home, env);
  const resolvedHome = home ?? homedir();
  const project = resolvePiProjectPath(base.cwd);
  const missingCandidate =
    project.kind === 'refused' && options.recordedOnly
      ? missingPiProjectPathCandidate(base.cwd)
      : undefined;
  const receiptCwd = project.kind === 'ready' ? project.project.canonical : missingCandidate;
  let receipts: PiTrustGrantReceipt[];
  try {
    receipts = accessPiTrustReceipts(resolvedHome, () => {
      const literal = listPiTrustGrants(resolvedHome, base.cwd);
      if (receiptCwd === undefined || receiptCwd === base.cwd) return literal;
      return [...listPiTrustGrants(resolvedHome, receiptCwd), ...literal];
    });
  } catch (error) {
    return {
      action: 'failed',
      error: escapeDisplayPath(error instanceof Error ? error.message : String(error)),
    };
  }
  if (receipts.length === 0 && options.recordedOnly) {
    if (project.kind === 'ready' || missingCandidate !== undefined)
      return { action: 'not-present' };
    return {
      action: 'kept-unverified',
      error: `${project.error}. OpenKnowledge could not verify whether this path refers to a project with recorded Pi trust; cleanup was left pending. Retry once the project path can be resolved to check again.`,
    };
  }
  if (project.kind === 'refused') {
    if (receipts.length === 0) return { action: 'kept-unverified', error: project.error };
    const records = receipts.map(
      ({ path, record }) =>
        `key ${escapeDisplayPath(JSON.stringify(record.cwd))}; configured store ${escapeDisplayPath(JSON.stringify(record.configuredTrustPath))}; recorded destination ${escapeDisplayPath(JSON.stringify(record.canonicalTrustPath))}; ownership record ${escapeDisplayPath(JSON.stringify(path))} (${record.state})`,
    );
    return {
      action: 'kept-unverified',
      error: [
        `${project.error}. OpenKnowledge kept these Pi trust ownership records; current trust decisions were not checked:`,
        ...records,
        'To review manually, close Pi, verify the intended store against its recorded destination, and inspect only the exact key. A pending record does not prove setup completed or ownership of a current grant. If you choose to undo a current true decision, restore the recorded previous value, or remove that key only when no previous entry was recorded. Preserve other current decisions; parent-folder and global trust settings still apply.',
      ].join('\n'),
    };
  }
  const resources = inspectPiTrustResources(
    project.project.canonical,
    resolvedHome,
    EDITOR_TARGETS.pi.projectConfigPath(project.project.canonical),
  );
  if (resources.kind === 'unreadable') {
    return { action: 'kept-unverified', error: resources.error };
  }
  const sharedPaths = resources.kind === 'shared' ? resources.paths : [];
  const outcomes: PiTrustRemoveResult[] = [];
  const stores = new Map<string, PiTrustRemovalStore>();
  const addStore = (trustPath: string, receipt?: PiTrustGrantReceipt): void => {
    let store = stores.get(trustPath);
    if (!store) {
      const resolved = resolvePiTrustFilePath(trustPath);
      if (resolved.kind === 'refused') {
        outcomes.push({ action: 'refused-unreadable', error: resolved.error });
        return;
      }
      store = { trustPath, resolved, keys: new Map() };
      stores.set(trustPath, store);
    }
    if (!receipt) return;
    if (store.resolved.path !== receipt.record.canonicalTrustPath) {
      outcomes.push({
        action: 'refused-unreadable',
        error: `Pi trust store ${escapeDisplayPath(trustPath)} no longer points to its recorded destination ${escapeDisplayPath(receipt.record.canonicalTrustPath)}; restore the intended file location or symlink, then retry`,
      });
      return;
    }
    store.keys.set(receipt.record.cwd, { cwd: receipt.record.cwd, mode: 'recorded', receipt });
  };
  for (const receipt of receipts) addStore(receipt.record.configuredTrustPath, receipt);
  addStore(base.trustPath);
  for (const store of stores.values()) {
    for (const key of [project.project.canonical, base.cwd]) {
      if (!store.keys.has(key)) {
        store.keys.set(key, {
          cwd: key,
          mode: 'inspect',
          receipt: receipts.find(
            (receipt) =>
              receipt.record.cwd === key &&
              receipt.record.canonicalTrustPath === store.resolved.path,
          ),
        });
      }
    }
    outcomes.push(removePiTrustStore(store, resolvedHome, sharedPaths, project.project));
  }
  return aggregatePiTrustRemoval(outcomes);
}

function accessPiTrustReceipts<T>(home: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PiTrustReceiptError) throw error;
    throw new Error(
      `Could not access OpenKnowledge's Pi trust ownership records at ${escapeDisplayPath(join(home, '.ok', 'pi-trust'))}: ${escapeDisplayPath(error instanceof Error ? error.message : String(error))}. Check the records and their permissions, then retry.`,
      { cause: error },
    );
  }
}

function removePiTrustStore(
  store: PiTrustRemovalStore,
  home: string,
  sharedPaths: string[],
  project: PiProjectPath,
): PiTrustRemoveResult {
  const { trustPath, resolved } = store;
  const keys = [...store.keys.values()];
  if (!keys.some((key) => key.mode === 'recorded') && resolved.kind === 'missing')
    return { action: 'not-present' };
  if (resolved.kind === 'missing') {
    try {
      lstatSync(dirname(resolved.path));
    } catch (error) {
      return {
        action: 'failed',
        error: `The recorded Pi trust directory ${escapeDisplayPath(dirname(resolved.path))} is unavailable: ${escapeDisplayPath(error instanceof Error ? error.message : String(error))}. Restore access to its parent directory or mounted drive, then retry; the ownership record was kept.`,
      };
    }
  }
  const outcomes: PiTrustRemoveResult[] = [];
  const captured: { result: PiTrustRemoveResult } = { result: { action: 'not-present' } };
  try {
    withPiTrustLockSync(trustPath, resolved.path, () => {
      const projectError = recheckPiProjectPath(project);
      if (projectError) {
        captured.result = { action: 'kept-unverified', error: projectError };
        return;
      }
      const checked = recheckPiTrustFilePath(trustPath, resolved);
      if (checked.kind === 'refused') {
        captured.result = { action: 'refused-unreadable', error: checked.error };
        return;
      }
      const current = readPiTrust(checked, project.canonical);
      if (current.state === 'unreadable') {
        captured.result = {
          action: 'refused-unreadable',
          error: refusedTrustPath(trustPath, current.reason).error,
        };
        return;
      }
      const currentKeys = keys.map((key) => ({
        cwd: key.cwd,
        mode: key.mode,
        expectedConfiguredPath: key.receipt?.record.configuredTrustPath,
        receipt: accessPiTrustReceipts(home, () =>
          listPiTrustGrants(home, key.cwd).find(
            (grant) => grant.record.canonicalTrustPath === checked.path,
          ),
        ),
      }));
      if (
        currentKeys.some(
          (key) =>
            key.receipt && key.receipt.record.configuredTrustPath !== key.expectedConfiguredPath,
        )
      ) {
        captured.result = {
          action: 'failed',
          error:
            'The Pi trust ownership record changed during cleanup; retry to read its current location.',
        };
        return;
      }
      for (const key of currentKeys) {
        try {
          removePiTrustKey(
            key,
            home,
            trustPath,
            checked.path,
            current,
            sharedPaths,
            project,
            captured,
          );
        } catch (error) {
          const detail = escapeDisplayPath(error instanceof Error ? error.message : String(error));
          const retry =
            error instanceof PiTrustReceiptError ? '' : '; retry to check its current state.';
          outcomes.push({
            action: 'failed',
            error: `Pi trust entry ${escapeDisplayPath(JSON.stringify(key.cwd))} in ${escapeDisplayPath(trustPath)} could not be reconciled: ${detail}${retry}`,
          });
        }
        outcomes.push(captured.result);
        captured.result = { action: 'not-present' };
      }
    });
  } catch (error) {
    outcomes.push({
      action: 'failed',
      error: escapeDisplayPath(error instanceof Error ? error.message : String(error)),
    });
  }
  return aggregatePiTrustRemoval([...outcomes, captured.result]);
}

function removePiTrustKey(
  key: PiTrustRemovalKey,
  home: string,
  trustPath: string,
  canonicalTrustPath: string,
  current: Extract<PiTrustReadResult, { entries: unknown }>,
  sharedPaths: string[],
  project: PiProjectPath,
  captured: { result: PiTrustRemoveResult },
): void {
  const { cwd, receipt } = key;
  if (current.entries[cwd] !== true) {
    if (receipt && key.mode === 'recorded')
      accessPiTrustReceipts(home, () => forgetPiTrustGrant(home, receipt));
    captured.result = { action: 'not-present' };
    return;
  }
  const manualAction = `To remove this grant manually, close Pi and remove only the ${escapeDisplayPath(JSON.stringify(cwd))} entry from ${escapeDisplayPath(trustPath)}; parent-folder and global trust settings still apply.`;
  if (sharedPaths.length > 0 && cwd === project.canonical) {
    const shown = sharedPaths
      .slice(0, 3)
      .map((path) => escapeDisplayPath(JSON.stringify(path)))
      .join(', ');
    const remaining = sharedPaths.length > 3 ? ` (+${sharedPaths.length - 3} more)` : '';
    const detail = `kept Pi's folder trust because other resources still need it: ${shown}${remaining}. ${manualAction} Removing this grant may stop Pi from loading those resources, including any not listed here.`;
    captured.result = { action: 'kept-shared', detail };
    if (receipt && key.mode === 'recorded')
      accessPiTrustReceipts(home, () => forgetPiTrustGrant(home, receipt));
    const ownership = !receipt
      ? 'OpenKnowledge has no ownership record for this grant and will not revoke it on later cleanup runs.'
      : key.mode === 'recorded'
        ? 'OpenKnowledge has relinquished this grant and will not revoke it on later cleanup runs.'
        : 'OpenKnowledge kept the existing ownership record; cleanup of its recorded location remains incomplete.';
    captured.result = { action: 'kept-shared', detail: `${detail} ${ownership}` };
    return;
  }
  if (key.mode === 'inspect' || !receipt || receipt.record.state === 'pending') {
    const reason = !receipt
      ? 'no OpenKnowledge ownership record exists; this includes every grant made before ownership recording was introduced.'
      : receipt.record.state === 'pending'
        ? 'its ownership record is pending after an interrupted setup; completion cannot be verified. Re-running setup or cleanup does not reconcile this record while the folder remains trusted.'
        : `OpenKnowledge must reconcile its recorded location at ${escapeDisplayPath(receipt.record.configuredTrustPath)} before removing it.`;
    const subject =
      cwd === project.canonical
        ? `kept Pi's folder trust because ${reason}`
        : `kept a Pi trust entry under a non-canonical project path because ${reason} Pi uses the real project directory instead of this key.`;
    captured.result = { action: 'kept-unowned', detail: `${subject} ${manualAction}` };
    return;
  }
  const next = { ...current.entries };
  if (receipt.record.previous.present) next[cwd] = receipt.record.previous.value;
  else delete next[cwd];
  const serialized = JSON.stringify(next, null, 2) + (current.trailingNewline ? '\n' : '');
  const mode = existingFileMode(canonicalTrustPath);
  atomicWriteFileSync(canonicalTrustPath, serialized, mode !== undefined ? { mode } : undefined);
  current.entries = next;
  accessPiTrustReceipts(home, () => forgetPiTrustGrant(home, receipt));
  captured.result = { action: 'removed' };
}

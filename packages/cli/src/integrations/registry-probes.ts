import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AGENTS_SKILLS_ROOT,
  buildProbeSnapshot,
  EDITOR_PROJECT_CONFIG_PATH,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
  type EditorId,
  EMPTY_DETECTION_SNAPSHOT,
  type HostSnapshot,
  HUB_READER_EDITORS,
  type ProbeAnswer,
  type ProbeResolver,
  type ProbeStrictness,
  parsePathId,
} from '@inkeep/open-knowledge-core';
import { scanSkillFolderStates } from '@inkeep/open-knowledge-core/skill-folder-state';
import {
  BUNDLE_SKILL_NAME,
  type BundleId,
  detectUserSkillHosts,
} from '@inkeep/open-knowledge-server';
import { ownServerMatcherFor } from '../commands/acp-harness-probe.ts';
import {
  ALL_EDITOR_IDS,
  canonicalEntryFor,
  EDITOR_TARGETS,
  entryCarriesDroppedManagedKey,
  isEntryUpToDate,
  isOwnManagedEntry,
  writerReplacesForeignEntry,
} from '../commands/editors.ts';
import {
  classifyExistingMcpEntry,
  isEditorTargetAvailable,
  writeWouldFabricateDetection,
} from '../commands/init.ts';

export interface CliProbeContext {
  readonly cwd: string;
  readonly home?: string;
}

function skillBundleAnswer(
  root: string,
  bundle: BundleId,
  sharedWith: readonly EditorId[] = [],
): ProbeAnswer {
  const state = existsSync(join(root, BUNDLE_SKILL_NAME[bundle])) ? 'satisfied' : 'absent';
  return {
    ...(state === 'satisfied' ? { state, strictness: ['reclaim-permissive'] as const } : { state }),
    ...(sharedWith.length === 0 ? {} : { sharedWith }),
  };
}

function skillRootEntries(
  roots: Readonly<Record<EditorId, string | null>>,
  scope: 'project' | 'global',
): { editor: string; root: string }[] {
  const editorRoots = ALL_EDITOR_IDS.flatMap((id) => {
    const root = roots[id];
    return root === null ? [] : [{ editor: id, root }];
  });
  const hubReaders = HUB_READER_EDITORS.filter((reader) => reader.scope === scope).map(
    (reader) => ({ editor: reader.editorId, root: AGENTS_SKILLS_ROOT }),
  );
  return [...editorRoots, ...hubReaders];
}

function skillRootPeers(
  base: string,
  roots: Readonly<Record<EditorId, string | null>>,
  editor: EditorId,
  scope: 'project' | 'global',
): EditorId[] {
  const states = scanSkillFolderStates(base, skillRootEntries(roots, scope));
  const own = states.find((entry) => entry.host === editor);
  if (own === undefined || own.state === 'absent') return [];
  const ownReal = own.real;
  return states
    .filter((entry) => entry.host !== editor && entry.state !== 'absent' && entry.real === ownReal)
    .map((entry) => entry.host as EditorId);
}

export function displayPath(absolute: string, home?: string): string {
  const base = (home ?? homedir()).replace(/[\\/]+$/, '');
  if (!base.includes('\\')) {
    return absolute.startsWith(`${base}/`) ? `~/${absolute.slice(base.length + 1)}` : absolute;
  }
  const slash = (p: string) => p.replace(/\\/g, '/');
  const slashedBase = slash(base);
  const slashedAbsolute = slash(absolute);
  return slashedAbsolute.startsWith(`${slashedBase}/`)
    ? `~/${slashedAbsolute.slice(slashedBase.length + 1)}`
    : absolute;
}

function userConfigWriterWouldRefuse(editor: EditorId, home: string | undefined): boolean {
  const target = EDITOR_TARGETS[editor];
  return (
    writeWouldFabricateDetection(target, '', home) && !isEditorTargetAvailable(target, '', home)
  );
}

function mcpEntryAnswer(
  editor: EditorId,
  declared: readonly ProbeStrictness[],
  cwd: string,
  home?: string,
  override?: string,
): ProbeAnswer {
  const target = EDITOR_TARGETS[editor];
  let resolved: string | undefined;
  if (override === undefined) {
    try {
      resolved = target.configPath(cwd, home);
    } catch {
      return { state: 'structural-na' };
    }
  } else {
    resolved = override;
  }
  const path = override === undefined ? displayPath(resolved, home) : undefined;
  const classification = classifyExistingMcpEntry(target, cwd, home, override);
  switch (classification.kind) {
    case 'absent':
    case 'no-entry':
      if (override === undefined && userConfigWriterWouldRefuse(editor, home)) {
        return { state: 'structural-na' };
      }
      return { state: 'absent', path };
    case 'decline':
      return { state: 'unprobed' };
    case 'present': {
      const { entry } = classification;
      const passed: ProbeStrictness[] = [];
      if (isEntryUpToDate(entry)) passed.push('reclaim-permissive');
      if (isOwnManagedEntry(entry)) passed.push('pre-approval-exact');
      if (ownServerMatcherFor(editor)(entry)) passed.push('injection-functional');
      const canonical = canonicalEntryFor(target, cwd);
      const editedSinceWritten =
        passed.length > 0 &&
        ((canonical !== null && entryCarriesDroppedManagedKey(entry, canonical)) ||
          (declared.includes('pre-approval-exact') &&
            passed.includes('reclaim-permissive') &&
            !passed.includes('pre-approval-exact')));
      if (editedSinceWritten) return { state: 'drifted', strictness: passed, path };
      if (passed.length > 0) return { state: 'satisfied', strictness: passed, path };
      return writerReplacesForeignEntry(target)
        ? { state: 'foreign-replaceable', path }
        : { state: 'foreign', path };
    }
  }
}

export function createCliProbeResolver(ctx: CliProbeContext): ProbeResolver {
  const { cwd, home } = ctx;
  return (item) => {
    if (item.pathId === null) return null;
    const location = parsePathId(item.pathId);
    if (location === null) return null;
    if (location.kind === 'central-skill-store') {
      return home === undefined
        ? null
        : skillBundleAnswer(
            join(home, AGENTS_SKILLS_ROOT),
            'discovery',
            skillRootPeers(home, EDITOR_USER_SKILL_ROOT, item.agent as EditorId, 'global'),
          );
    }
    const editor = location.editor;
    switch (location.kind) {
      case 'editor-user-skill-root': {
        const root = EDITOR_USER_SKILL_ROOT[editor];
        if (root === null || home === undefined) return null;
        if (!detectUserSkillHosts(home).some((host) => host.editorId === editor)) {
          return { state: 'structural-na' };
        }
        return skillBundleAnswer(
          join(home, root),
          'discovery',
          skillRootPeers(home, EDITOR_USER_SKILL_ROOT, editor, 'global'),
        );
      }
      case 'editor-project-skill-root': {
        const root = EDITOR_PROJECT_SKILL_ROOT[editor];
        return root === null
          ? null
          : skillBundleAnswer(
              join(cwd, root),
              'project',
              skillRootPeers(cwd, EDITOR_PROJECT_SKILL_ROOT, editor, 'project'),
            );
      }
      case 'editor-user-config':
        return mcpEntryAnswer(editor, item.strictness, cwd, home);
      case 'editor-project-config': {
        const relative = EDITOR_PROJECT_CONFIG_PATH[editor];
        return relative === null
          ? null
          : mcpEntryAnswer(editor, item.strictness, cwd, home, join(cwd, relative));
      }
    }
  };
}

export async function collectCliHostSnapshot(ctx: CliProbeContext): Promise<HostSnapshot> {
  return {
    probes: await buildProbeSnapshot({ env: 'desktop', resolve: createCliProbeResolver(ctx) }),
    detection: EMPTY_DETECTION_SNAPSHOT,
  };
}

import type { LintPluginId } from '@inkeep/open-knowledge-core';
import type { PackId } from './starter.ts';

export interface PackSkillConflict {
  name: string;
  hosts?: string[];
}

export interface FileEntry {
  path: string;
  kind: 'folder' | 'file';
  template?: string;
  contentPreview?: string;
}

export interface SkipEntry {
  path: string;
  reason: 'already-exists' | 'user-content' | 'glob-collision';
}

export interface ScaffoldPlan {
  created: FileEntry[];
  skipped: SkipEntry[];
  warnings: string[];
  packSkills?: { name: string; pending: boolean; conflict?: boolean }[];
  requiredPlugins?: { id: LintPluginId; pending: boolean }[];
  packSkillHomeRefusal?: 'no-agent-folder' | 'home-escapes-project';
}

export interface ApplyResult {
  applied: number;
  errors: ApplyError[];
  durationMs: number;
  packSkillsInstalled: string[];
  pluginsEnabled: LintPluginId[];
  packSkillConflicts: PackSkillConflict[];
}

export interface ApplyError {
  path: string;
  error: string;
}

export interface SeedOptions {
  projectDir?: string;
  rootDir?: string;
  packId?: PackId;
  skipPrerequisite?: boolean;
}

export class SeedPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedPrerequisiteError';
  }
}

export class SeedRootDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRootDirError';
  }
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tracedMkdirSync, tracedWriteFileSync } from './fs-traced.ts';

interface BaselinePair {
  readonly local: string;
  readonly upstream: string;
}

type BaselineFile = Record<string, BaselinePair>;

const REL_PATH = ['.ok', 'local', 'plugin-skill-baselines.json'] as const;

function fileOf(contentDir: string): string {
  return join(contentDir, ...REL_PATH);
}

function readBaselines(contentDir: string): BaselineFile {
  try {
    const p = fileOf(contentDir);
    if (!existsSync(p)) return {};
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: BaselineFile = Object.create(null) as BaselineFile;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof v === 'object' &&
        v !== null &&
        typeof (v as BaselinePair).local === 'string' &&
        typeof (v as BaselinePair).upstream === 'string'
      )
        out[k] = { local: (v as BaselinePair).local, upstream: (v as BaselinePair).upstream };
    }
    return out;
  } catch {
    return {};
  }
}

export function decidePluginBaseline(
  stored: BaselinePair | undefined,
  localHash: string,
  upstreamHash: string,
): { modified: boolean; next: BaselinePair } {
  if (stored === undefined || stored.upstream !== upstreamHash)
    return { modified: false, next: { local: localHash, upstream: upstreamHash } };
  return { modified: localHash !== stored.local, next: stored };
}

export function openPluginBaselines(contentDir: string): {
  isModified: (
    scope: 'project' | 'global',
    name: string,
    localHash: string,
    upstreamHash: string,
  ) => boolean;
  flush: () => void;
} {
  const baselines = readBaselines(contentDir);
  let dirty = false;
  return {
    isModified(scope, name, localHash, upstreamHash) {
      const key = `${scope}:${name}`;
      const { modified, next } = decidePluginBaseline(baselines[key], localHash, upstreamHash);
      const prev = baselines[key];
      if (prev === undefined || prev.local !== next.local || prev.upstream !== next.upstream) {
        baselines[key] = next;
        dirty = true;
      }
      return modified;
    },
    flush() {
      if (!dirty) return;
      dirty = false;
      try {
        tracedMkdirSync(join(contentDir, '.ok', 'local'), { recursive: true });
        tracedWriteFileSync(fileOf(contentDir), `${JSON.stringify(baselines, null, 2)}\n`);
      } catch {}
    },
  };
}

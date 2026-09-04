import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWriterId } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type { ShadowHandle } from './shadow-repo.ts';
import { shadowGit } from './shadow-repo.ts';

export interface ShadowObjectStats {
  looseObjects: number;
  looseKiB: number;
  packfiles: number;
  packedObjects: number;
}

export async function countShadowObjects(shadow: ShadowHandle): Promise<ShadowObjectStats> {
  const sg = shadowGit(shadow);
  const raw = await sg.raw('count-objects', '-v');
  const fields = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = Number.parseInt(line.slice(idx + 1).trim(), 10);
    if (key) fields.set(key, Number.isFinite(value) ? value : 0);
  }
  return {
    looseObjects: fields.get('count') ?? 0,
    looseKiB: fields.get('size') ?? 0,
    packfiles: fields.get('packs') ?? 0,
    packedObjects: fields.get('in-pack') ?? 0,
  };
}

export function hasGcLogLatch(shadow: ShadowHandle): boolean {
  return existsSync(resolve(shadow.gitDir, 'gc.log'));
}

export async function countWipRefs(shadow: ShadowHandle, branch?: string): Promise<number> {
  const sg = shadowGit(shadow);
  const pattern = branch ? `refs/wip/${branch}/` : 'refs/wip/';
  try {
    const raw = await sg.raw('for-each-ref', '--format=%(refname)', pattern);
    return raw.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

export async function countStaleAgentWipRefs(
  shadow: ShadowHandle,
  cutoffMs: number,
): Promise<number> {
  const sg = shadowGit(shadow);
  let lines: string[];
  try {
    lines = (
      await sg.raw(
        'for-each-ref',
        '--format=%(refname)%00%(committerdate:unix)%00%(contents:subject)',
        'refs/wip/',
      )
    )
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of lines) {
    const [refname = '', committerUnix = '', subject = ''] = line.split('\x00');
    if (subject.startsWith('park:')) continue;
    const writerId = refname.split('/').slice(3).join('/');
    if (!writerId) continue;
    if (parseWriterId(writerId).classification !== 'agent') continue;
    const unix = Number.parseInt(committerUnix, 10);
    if (!Number.isFinite(unix)) continue;
    if (unix * 1000 < cutoffMs) count += 1;
  }
  return count;
}

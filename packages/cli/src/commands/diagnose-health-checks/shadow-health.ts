import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCheckpoint, resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import {
  countShadowObjects,
  countStaleAgentWipRefs,
  countWipRefs,
  hasGcLogLatch,
} from '@inkeep/open-knowledge-server';
import simpleGit from 'simple-git';
import type { CheckContext, CheckDefinition, CheckResult } from './types.ts';

const LOOSE_WARN = 2000;
const WIDTH_WARN = 20;
const DEAD_CHAIN_WARN = 5;
const DEAD_CHAIN_STALE_MS = 30 * 60 * 1000;

export interface ShadowHealthFacts {
  looseObjects: number;
  packfiles: number;
  wipWidth: number;
  /** Dead `agent-*` chains unfolded past the staleness window — the strict
   *  auto-consolidation-health signal (near zero when the fast path keeps up,
   *  unlike raw width which counts live sessions too). `principal-*` chains are
   *  excluded: they fold on the 30-day TTL, not this fast path. */
  deadChains: number;
  gcLogLatch: boolean;
  lastPackedAtMs: number | null;
  lastConsolidationAtMs: number | null;
}

export interface ShadowHealthCheckDeps {
  resolveDir?: (projectRoot: string) => string;
  readFacts?: (shadowDir: string, cwd: string) => Promise<ShadowHealthFacts>;
}

async function defaultReadFacts(shadowDir: string, cwd: string): Promise<ShadowHealthFacts> {
  const handle = { gitDir: shadowDir, workTree: cwd };
  const objects = await countShadowObjects(handle);
  const wipWidth = await countWipRefs(handle);
  const deadChains = await countStaleAgentWipRefs(handle, Date.now() - DEAD_CHAIN_STALE_MS);
  const gcLogLatch = hasGcLogLatch(handle);

  let lastPackedAtMs: number | null = null;
  for (const rel of ['objects/info/commit-graph', 'objects/info/commit-graphs']) {
    const p = resolve(shadowDir, rel);
    if (existsSync(p)) {
      try {
        lastPackedAtMs = Math.max(lastPackedAtMs ?? 0, statSync(p).mtimeMs);
      } catch {}
    }
  }

  let lastConsolidationAtMs: number | null = null;
  try {
    const sg = simpleGit({ baseDir: cwd, timeout: { block: 4000 } }).env({ GIT_DIR: shadowDir });
    const shas = (
      await sg.raw(
        'for-each-ref',
        '--sort=-creatordate',
        '--format=%(objectname)',
        'refs/checkpoints/',
      )
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(0, 25);
    for (const sha of shas) {
      const out = (await sg.raw('log', '-1', '--format=%cI%x00%B', sha)).trim();
      const nul = out.indexOf('\x00');
      if (nul < 0) continue;
      const iso = out.slice(0, nul);
      const body = out.slice(nul + 1);
      if (parseCheckpoint(body)?.kind === 'auto-consolidation') {
        const ms = Date.parse(iso);
        if (Number.isFinite(ms)) lastConsolidationAtMs = ms;
        break; // sorted newest-first
      }
    }
  } catch {}

  return {
    looseObjects: objects.looseObjects,
    packfiles: objects.packfiles,
    wipWidth,
    deadChains,
    gcLogLatch,
    lastPackedAtMs,
    lastConsolidationAtMs,
  };
}

function relTime(ms: number | null): string {
  if (ms === null) return 'never';
  const ageMs = Date.now() - ms;
  const days = ageMs / (24 * 60 * 60 * 1000);
  if (days >= 1) return `${Math.round(days)}d ago`;
  const hours = ageMs / (60 * 60 * 1000);
  if (hours >= 1) return `${Math.round(hours)}h ago`;
  return `${Math.max(0, Math.round(ageMs / 60000))}m ago`;
}

export function makeShadowHealthCheck(deps: ShadowHealthCheckDeps = {}): CheckDefinition {
  const resolveDir = deps.resolveDir ?? resolveShadowDir;
  const readFacts = deps.readFacts ?? defaultReadFacts;
  return {
    name: 'shadow-health',
    run: async (ctx: CheckContext): Promise<CheckResult> => {
      const gitDir = resolve(ctx.cwd, '.git');
      if (!existsSync(gitDir)) {
        return {
          name: 'shadow-health',
          status: 'warn',
          summary: 'no .git/ at project root (shadow repo not initialized)',
          remediation: 'Run `ok start` once to initialize the shadow repo.',
        };
      }
      let shadowDir: string;
      try {
        shadowDir = resolveDir(ctx.cwd);
      } catch (err) {
        return {
          name: 'shadow-health',
          status: 'warn',
          summary: `cannot resolve shadow gitdir: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!existsSync(shadowDir)) {
        return {
          name: 'shadow-health',
          status: 'warn',
          summary: 'shadow repo not yet initialized',
          remediation: 'Run `ok start` once to initialize the shadow repo.',
        };
      }

      const facts = await readFacts(shadowDir, ctx.cwd);
      const reasons: string[] = [];
      if (facts.gcLogLatch) {
        reasons.push('gc.log latch present (auto-packing disabled until it self-expires)');
      }
      if (facts.looseObjects > LOOSE_WARN) {
        reasons.push(`${facts.looseObjects} loose objects (unpacked)`);
      } else if (facts.packfiles === 0 && facts.looseObjects > 512) {
        reasons.push(`${facts.looseObjects} loose objects, never packed`);
      }
      if (facts.deadChains > DEAD_CHAIN_WARN) {
        reasons.push(
          `${facts.deadChains} dead chains unfolded (auto-consolidation not keeping up)`,
        );
      }
      if (facts.wipWidth > WIDTH_WARN) {
        reasons.push(`${facts.wipWidth} WIP refs (version-journal width high)`);
      }

      const detail = [
        `loose objects: ${facts.looseObjects}`,
        `packfiles: ${facts.packfiles}`,
        `WIP refs: ${facts.wipWidth}`,
        `dead chains: ${facts.deadChains}`,
        `gc.log latch: ${facts.gcLogLatch ? 'present' : 'none'}`,
        `last packed: ${relTime(facts.lastPackedAtMs)}`,
        `last fold: ${relTime(facts.lastConsolidationAtMs)}`,
      ].join(', ');

      if (reasons.length > 0) {
        return {
          name: 'shadow-health',
          status: 'warn',
          summary: `history may be slow: ${reasons.join('; ')}`,
          remediation:
            'Packing and journal cleanup run automatically on the next server start and during use. If this persists, check the server logs.',
          detail,
        };
      }

      return {
        name: 'shadow-health',
        status: 'pass',
        summary: `${facts.looseObjects} loose, ${facts.packfiles} packs, ${facts.wipWidth} WIP refs`,
        detail,
      };
    },
  };
}

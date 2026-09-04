import { existsSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { EditorId } from '@inkeep/open-knowledge-core';
import { AGENTS_SKILLS_ROOT, isSkillInstallTarget } from '@inkeep/open-knowledge-core';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';
import { tracedCpSync, tracedMkdirSync, tracedRmSync, tracedSymlinkSync } from '../fs-traced.ts';
import {
  isRefusedOkPlacementRoot,
  readSkillPlacements,
  recordSkillPlacement,
  removeSkillPlacement,
  resolveSkillPlacementPath,
} from '../skill-placements.ts';
import { classifyInPlaceDest, skillProjectionRoots } from '../skill-projection.ts';

type PlaceOutcome =
  | { ok: true; placedAt: string }
  | { ok: true; alreadyAtSource: true; placedAt: string }
  | { ok: false; kind: 'invalid-path' }
  | { ok: false; kind: 'dest-exists' };

type UnplaceOutcome =
  | { ok: true }
  | { ok: false; kind: 'not-recorded'; path: string }
  | { ok: false; kind: 'unsafe-path' }
  | { ok: false; kind: 'forked'; path: string }
  | { ok: false; kind: 'canonical-dir'; path: string };

type ConvertOutcome =
  | { ok: true }
  | { ok: false; kind: 'invalid-location' }
  | { ok: false; kind: 'canonical-dir' }
  | { ok: false; kind: 'forked' }
  | { ok: false; kind: 'not-installed' };

export interface SkillPlacementOpsService {
  place(input: {
    placeBase: string;
    name: string;
    rawDir: string;
    skillDir: string;
    mode: 'link' | 'copy';
  }): Promise<PlaceOutcome>;
  unplace(input: {
    placeBase: string;
    name: string;
    rawPath: string;
    skillDir: string;
  }): Promise<UnplaceOutcome>;
  convert(input: {
    ledgerBase: string;
    scope: 'project' | 'global';
    name: string;
    target: string;
    mode: 'link' | 'copy';
    skillDir: string;
    canonicalHash: string;
  }): Promise<ConvertOutcome>;
}

export function createSkillPlacementOpsService(): SkillPlacementOpsService {
  return {
    async place(input) {
      const dirRel = input.rawDir
        .replace(/\\/g, '/')
        .replace(/^~\//, '')
        .replace(/^\/+|\/+$/g, '');
      const parentAbs = resolve(input.placeBase, dirRel);
      const placementRel = `${dirRel}/${input.name}`;
      const destAbs = resolveSkillPlacementPath(input.placeBase, placementRel);
      const baseAbs = resolve(input.placeBase);
      const underOkInternals = isRefusedOkPlacementRoot(dirRel);
      if (
        dirRel === '' ||
        destAbs === null ||
        !destAbs.startsWith(baseAbs + sep) ||
        underOkInternals
      ) {
        return { ok: false, kind: 'invalid-path' };
      }
      if (destAbs === resolve(input.skillDir)) {
        return { ok: true, alreadyAtSource: true, placedAt: placementRel };
      }
      if (existsSync(destAbs)) {
        return { ok: false, kind: 'dest-exists' };
      }
      tracedMkdirSync(parentAbs, { recursive: true });
      if (input.mode === 'link') {
        tracedSymlinkSync(relative(parentAbs, resolve(input.skillDir)), destAbs, 'dir');
      } else {
        tracedCpSync(input.skillDir, destAbs, { recursive: true, dereference: true });
      }
      await recordSkillPlacement(input.placeBase, input.name, {
        path: placementRel,
        mode: input.mode,
        ...(input.mode === 'copy' ? { hash: parseSkillDir(input.skillDir)?.contentHash } : {}),
      });
      return { ok: true, placedAt: placementRel };
    },

    async unplace(input) {
      const rel = input.rawPath
        .replace(/\\/g, '/')
        .replace(/^~\//, '')
        .replace(/^\/+|\/+$/g, '');
      const recorded = readSkillPlacements(input.placeBase)[input.name]?.find(
        (p) => p.path === rel,
      );
      if (!recorded) {
        return { ok: false, kind: 'not-recorded', path: rel };
      }
      const absDir = resolveSkillPlacementPath(input.placeBase, rel);
      if (absDir === null) {
        return { ok: false, kind: 'unsafe-path' };
      }
      const canonicalHash = parseSkillDir(input.skillDir)?.contentHash ?? '';
      switch (classifyInPlaceDest(absDir, resolve(input.skillDir), canonicalHash)) {
        case 'different':
          return { ok: false, kind: 'forked', path: rel };
        case 'canonical-dir':
          return { ok: false, kind: 'canonical-dir', path: rel };
        case 'absent':
          break;
        default:
          tracedRmSync(absDir, { recursive: true, force: true });
      }
      await removeSkillPlacement(input.placeBase, input.name, rel);
      return { ok: true };
    },

    async convert(input) {
      const roots = skillProjectionRoots(input.scope);
      const isHost = isSkillInstallTarget(input.target);
      const rootRel = isHost
        ? input.target === 'agents'
          ? AGENTS_SKILLS_ROOT
          : roots[input.target as EditorId]
        : input.target
            .replace(/\\/g, '/')
            .replace(/^~\//, '')
            .replace(/^\/+|\/+$/g, '');
      const absDir =
        rootRel === null || rootRel === ''
          ? null
          : resolveSkillPlacementPath(input.ledgerBase, `${rootRel}/${input.name}`);
      if (rootRel === null || rootRel === '' || absDir === null) {
        return { ok: false, kind: 'invalid-location' };
      }
      const canonicalAbs = resolve(input.skillDir);
      const cls = classifyInPlaceDest(absDir, canonicalAbs, input.canonicalHash);
      if (cls === 'canonical-dir') {
        return { ok: false, kind: 'canonical-dir' };
      }
      if (cls === 'different') {
        return { ok: false, kind: 'forked' };
      }
      if (cls === 'absent') {
        return { ok: false, kind: 'not-installed' };
      }
      const alreadyRight =
        (input.mode === 'link' && cls === 'link-to-canonical') ||
        (input.mode === 'copy' && cls === 'same-copy');
      if (!alreadyRight) {
        const hostRoot = dirname(absDir);
        tracedRmSync(absDir, { recursive: true, force: true });
        tracedMkdirSync(hostRoot, { recursive: true });
        if (input.mode === 'link') {
          tracedSymlinkSync(relative(hostRoot, canonicalAbs), absDir, 'dir');
        } else {
          tracedCpSync(canonicalAbs, absDir, { recursive: true, dereference: true });
        }
      }
      await recordSkillPlacement(input.ledgerBase, input.name, {
        path: `${rootRel}/${input.name}`,
        mode: input.mode,
        ...(input.mode === 'copy' ? { hash: input.canonicalHash } : {}),
      });
      return { ok: true };
    },
  };
}

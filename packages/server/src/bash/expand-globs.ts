import { glob } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import {
  checkStage,
  classifyArgs,
  type GlobStage,
  type ParseCommandError,
  type Stage,
  WIKI_EXCLUDE_DIRS,
} from './parse-command.ts';

const EXPANDABLE_PATTERN_RE = /^[^-][\w.\-/*?[\]!^]*$/;

export const GLOB_EXPANSION_CAP = 1000;

const EXCLUDED = new Set(WIKI_EXCLUDE_DIRS);

type ExpandResult = { stages: Stage[] } | { error: ParseCommandError };

function expandableArgIndices(stage: Stage): ReadonlySet<number> {
  return new Set(
    classifyArgs(stage)
      .filter((a) => a.role === 'path')
      .map((a) => a.index),
  );
}

function overCap(arg: string, cap: number): ExpandResult {
  return {
    error: {
      category: 'shell_construct_blocked',
      message: `The pattern '${arg}' matches more than ${cap} paths. Narrow it to a subdirectory, or use 'find' or 'grep -r' to search.`,
    },
  };
}

export async function expandGlobStages(
  stages: GlobStage[],
  cwd: string,
  cap: number = GLOB_EXPANSION_CAP,
): Promise<ExpandResult> {
  const expanded: Stage[] = [];
  for (const stage of stages) {
    const globs = stage.globArgIndices;
    if (globs.length === 0) {
      expanded.push({ command: stage.command, args: stage.args });
      continue;
    }
    const expandable = expandableArgIndices(stage);
    const args: string[] = [];
    for (const [index, arg] of stage.args.entries()) {
      if (
        !globs.includes(index) ||
        !expandable.has(index) ||
        !EXPANDABLE_PATTERN_RE.test(arg) ||
        arg.includes('..') ||
        isAbsolute(arg)
      ) {
        args.push(arg);
        continue;
      }
      const matches: string[] = [];
      try {
        for await (const match of glob(arg, {
          cwd,
          exclude: (entry: unknown) => EXCLUDED.has(basename(String(entry))),
        })) {
          const m = String(match);
          if (isAbsolute(m) || m.startsWith('..')) continue;
          matches.push(m);
          if (matches.length > cap) return overCap(arg, cap);
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        return {
          error: {
            category: 'shell_construct_blocked',
            message:
              code === undefined
                ? `Could not expand the pattern '${arg}': ${error instanceof Error ? error.message : String(error)}. Quote it to match it literally.`
                : `Could not expand the pattern '${arg}': the walk failed with ${code}.`,
          },
        };
      }
      if (matches.length === 0) {
        args.push(arg);
        continue;
      }
      matches.sort();
      args.push(...matches);
    }
    const next: Stage = { command: stage.command, args };
    const stageError = checkStage(next);
    if (stageError) return { error: stageError };
    expanded.push(next);
  }
  return { stages: expanded };
}

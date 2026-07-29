/**
 * Environment for spawning `git` with an explicit `cwd`/`-C` target.
 *
 * Git hooks (pre-push, pre-commit) export GIT_DIR — and in a linked
 * worktree that value contradicts any explicit working directory the
 * subprocess sets, failing with "fatal: this operation must be run in a
 * work tree". Worse: with GIT_DIR inherited, `git init <path>` ignores its
 * target and re-initialises the CALLER's worktree admin dir, writing
 * core.bare=true into the shared .git/config. Every git spawn in these
 * scripts means "the repo at the given path", never "whatever repo the
 * calling hook belongs to", so the inherited GIT_* variables are always
 * wrong here.
 *
 * Deletion list mirrors GIT_SCRUB_VARS in the root repo's
 * scripts/check-git-env-scrub.mjs (the authoritative list; see its comment
 * for the full set of helper copies) — keep in sync.
 */
export function gitCleanEnv(base = process.env) {
  const {
    GIT_DIR: _d,
    GIT_WORK_TREE: _w,
    GIT_COMMON_DIR: _c,
    GIT_INDEX_FILE: _i,
    GIT_OBJECT_DIRECTORY: _o,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: _a,
    GIT_NAMESPACE: _n,
    GIT_PREFIX: _p,
    ...env
  } = base;
  return env;
}

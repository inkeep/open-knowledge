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

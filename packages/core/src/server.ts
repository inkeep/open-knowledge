/**
 * Node-only sub-export for `@inkeep/open-knowledge-core`.
 *
 * The exports in here statically import `node:fs`, `node:fs/promises`,
 * `node:os`, and `node:path` — bundling them into a browser build via Vite
 * produces "Module 'node:fs' has been externalized" runtime errors as soon
 * as a stub property is accessed.
 *
 * Browser consumers (`packages/app`) keep importing from the main barrel
 * (`@inkeep/open-knowledge-core`); server / cli / desktop main consumers
 * import from `@inkeep/open-knowledge-core/server` to reach the writers.
 *
 * STOP rule: never re-export anything from this file via `src/index.ts` —
 * the split is the contract.
 */

export {
  type CollectConfigDiagnosticsOptions,
  collectConfigDiagnostics,
} from './config/collect-config-diagnostics.ts';
export {
  type ConfigPathPresence,
  type InspectConfigPathsOptions,
  inspectConfigPaths,
} from './config/inspect-config-paths.ts';
export {
  type ReadConfigSafelyOptions,
  type ReadConfigSafelyResult,
  readConfigSafely,
} from './config/read-config-safely.ts';
export {
  DEFAULT_LOGS_MAX_BYTES,
  DEFAULT_SPANS_MAX_BYTES,
  DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST,
} from './config/schema.ts';
export {
  resolveConfigPath,
  USER_CONFIG_FILENAME,
  type WriteConfigPatchOptions,
  type WriteConfigPatchResult,
  type WriteConfigPatchSuccess,
  writeConfigPatch,
} from './config/write-config-patch.ts';
// The Node locale signal provider. Node-only for one reason — it reads
// `process.env` — but that is enough to keep it out of the root barrel, since
// the renderer bundles that barrel. The pure resolver it feeds stays browser-safe.
export {
  LOCALE_OVERRIDE_ENV_VAR,
  type LocaleEnvironment,
  type NodeLocaleSignal,
  readNodeLocaleSignal,
} from './i18n/node-locale-provider.ts';
export {
  type AtomicWriteFsAdapter,
  type AtomicWriteOptions,
  type AtomicWriteSyncOptions,
  atomicWriteFile,
  atomicWriteFileSync,
} from './util/atomic-yaml-write.ts';
export {
  FileLockTimeoutError,
  type WithFileLockOptions,
  withFileLock,
  withFileLockSync,
} from './util/file-lock.ts';

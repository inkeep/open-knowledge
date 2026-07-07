/**
 * Re-export shim. The process-scan utilities (`discoverLockDirs` + helpers)
 * moved to `@inkeep/open-knowledge-server` so the MCP preview resolver (which
 * lives in `server`) can consume off-cwd discovery directly — `cli` depends on
 * `server`, not the reverse, so the discovery primitive has to live in the
 * lower layer. CLI consumers (`ok ps` / `ok stop` / `ok diagnose`) keep their
 * existing `../utils/process-scan.ts` import path through this shim.
 *
 * Only the symbols cli actually consumes are re-exported here; the rest of the
 * process-scan surface (e.g. findOkProcessPids, pidCwd) is used only inside
 * server and stays there.
 */
export {
  discoverLockDirs,
  extractOkBinaryPath,
  type ProcessUsage,
  processCommand,
  processUsage,
} from '@inkeep/open-knowledge-server';

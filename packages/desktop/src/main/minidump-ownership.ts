/**
 * Decide whether a minidump in our crash database was written for one of OUR
 * processes.
 *
 * The question is not rhetorical. On macOS a task's Mach exception ports are
 * inherited across fork/exec, so every descendant of the desktop process — the
 * in-app terminal's login shell, anything that shell launches, an MCP server, a
 * wholly unrelated GUI application started from that terminal — runs under the
 * Crashpad handler this app started. When such a process aborts, Crashpad
 * writes the dump into `app.getPath('crashDumps')` and stamps it with THIS
 * app's annotations (product name, version, `prod = Electron`). Nothing in the
 * dump's location or metadata distinguishes it from a real crash of ours.
 *
 * The dump's own module list does. `ModuleList[0]` is the crashed process's
 * main executable, recorded by the loader rather than by the annotation
 * pipeline, so it names the actual program that died. Resolving that path
 * against the app bundle root separates "we crashed" from "something we
 * happened to be the exception handler for crashed".
 *
 * Two Crashpad conventions carry that, and NEITHER is guaranteed by the
 * minidump format itself — they are behavior, not spec:
 *
 *   1. `ModuleList[0]` is the main executable, not just some loaded image.
 *   2. Its name is recorded as a full absolute path, not a basename.
 *
 * Both hold for Crashpad as shipped, and both were checked against real dumps
 * (one of ours, one from an unrelated app) when this was written. They are
 * written down here because the tests cannot check them: every test feeds this
 * parser bytes from a builder that assumes the same layout, so a future
 * Electron bump that reorders the module list or shortens the name would leave
 * the whole suite green. The failure is one-directional and quiet — nothing
 * leaks, but the attach-dump checkbox silently stops appearing.
 *
 * Drift surfaces in the crash-detection logs, and WHICH counter moves says
 * which kind it was. A reordered list or a shortened name still parses, so it
 * lands as `'foreign'`. Anything structural — record sizes, stream layout —
 * fails the parse instead and lands as `'unknown'`, which is why that count is
 * reported separately rather than folded in: on a crash that was plainly ours,
 * it is the only thing that moves.
 *
 * Reads only the handful of records it needs at explicit file offsets: a
 * minidump is raw process memory and can be hundreds of megabytes, so it must
 * never be slurped whole to answer a path question. No symbolizer, no Crashpad
 * tooling, no Electron.
 */

import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { isPathWithinProject } from './path-containment.ts';

/**
 * `'unknown'` is a real third answer, not an error channel: a dump truncated by
 * the very crash that produced it, or written by a Crashpad revision whose
 * layout we don't recognize, has no honest owner. Callers choose their own
 * default for it, and the two callers here choose opposite ones.
 */
export type MinidumpOwnership = 'ours' | 'foreign' | 'unknown';

/** `MDMP` as a little-endian u32 — the minidump header signature. */
const MINIDUMP_SIGNATURE = 0x504d_444d;
const HEADER_BYTES = 32;
const NUMBER_OF_STREAMS_OFFSET = 8;
const STREAM_DIRECTORY_RVA_OFFSET = 12;
/** Directory entry: `(streamType u32, dataSize u32, rva u32)`. */
const DIRECTORY_ENTRY_BYTES = 12;
const DIRECTORY_ENTRY_RVA_OFFSET = 8;
/** `ModuleListStream` in the minidump stream-type enum. */
const MODULE_LIST_STREAM_TYPE = 4;
const MODULE_RECORD_BYTES = 108;
const MODULE_NAME_RVA_OFFSET = 20;

/**
 * Ceilings on the two counts read out of the file before any allocation. A
 * corrupt or hostile dump can name any u32 here, and a dump is untrusted input
 * for exactly the reason this module exists: it may have been written for a
 * process that is not ours.
 */
const MAX_STREAMS = 4096;
/** Byte length of the UTF-16 module name; real executable paths are far shorter. */
const MAX_MODULE_NAME_BYTES = 8192;

/** Exact positional read, or null when the file is shorter than the request. */
function readExactly(fd: number, length: number, position: number): Buffer | null {
  const buf = Buffer.alloc(length);
  return readSync(fd, buf, 0, length, position) === length ? buf : null;
}

/**
 * Path of `ModuleList[0]` — the crashed process's main executable — or null
 * when the file is not a minidump we can read that far into.
 */
function readMainModulePath(dumpPath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(dumpPath, 'r');
    const header = readExactly(fd, HEADER_BYTES, 0);
    if (header === null || header.readUInt32LE(0) !== MINIDUMP_SIGNATURE) return null;
    const streamCount = header.readUInt32LE(NUMBER_OF_STREAMS_OFFSET);
    if (streamCount === 0 || streamCount > MAX_STREAMS) return null;

    const directory = readExactly(
      fd,
      streamCount * DIRECTORY_ENTRY_BYTES,
      header.readUInt32LE(STREAM_DIRECTORY_RVA_OFFSET),
    );
    if (directory === null) return null;
    let moduleListRva: number | null = null;
    for (let i = 0; i < streamCount; i += 1) {
      const at = i * DIRECTORY_ENTRY_BYTES;
      if (directory.readUInt32LE(at) === MODULE_LIST_STREAM_TYPE) {
        moduleListRva = directory.readUInt32LE(at + DIRECTORY_ENTRY_RVA_OFFSET);
        break;
      }
    }
    if (moduleListRva === null) return null;

    const moduleCount = readExactly(fd, 4, moduleListRva);
    if (moduleCount === null || moduleCount.readUInt32LE(0) === 0) return null;
    const firstModule = readExactly(fd, MODULE_RECORD_BYTES, moduleListRva + 4);
    if (firstModule === null) return null;

    // A minidump string is a byte length followed by UTF-16LE units — the
    // length counts BYTES, not code units, so an odd value is malformed.
    const nameRva = firstModule.readUInt32LE(MODULE_NAME_RVA_OFFSET);
    const nameLength = readExactly(fd, 4, nameRva);
    if (nameLength === null) return null;
    const nameBytes = nameLength.readUInt32LE(0);
    if (nameBytes === 0 || nameBytes % 2 !== 0 || nameBytes > MAX_MODULE_NAME_BYTES) return null;
    const name = readExactly(fd, nameBytes, nameRva + 4);
    return name === null ? null : name.toString('utf16le');
  } catch {
    // Unopenable file, torn read, permissions change mid-scan, or a corrupt
    // dump — all mean the same thing to the caller.
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Descriptor already reclaimed; nothing left to release.
      }
    }
  }
}

/**
 * Canonical spelling of `path`, or `path` unchanged when it resolves nowhere —
 * a dump routinely outlives the binary that wrote it (deleted app, replaced
 * bundle after an update, unreadable parent).
 */
function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Classify `dumpPath` against `appBundleRoot` — the root every process of this
 * app launches from, so helper processes (renderer, GPU, utility) all resolve
 * inside it alongside the main binary.
 *
 * Containment is asked twice because the two sides do not spell paths the same
 * way. Crashpad records the main module as the loader saw it, symlinks intact:
 * the path the process was actually invoked through. `appBundleRoot` descends
 * from Electron's `app.getPath('exe')`, which Chromium puts through `realpath`
 * before returning. One symlink anywhere in the launch path is enough to give a
 * single file two spellings, so the canonical forms are compared first; a dev
 * run reaching Electron through pnpm's linked `node_modules/electron` is the
 * everyday case, and under text comparison alone every own dump from one reads
 * as somebody else's. The raw comparison stays as the fallback for when either
 * side no longer resolves.
 *
 * Resolution can only ever widen `'ours'` to a module that physically sits
 * inside the bundle, which is what ownership means. A name that reads but lands
 * under neither spelling of the root is `'foreign'` — we learned what died and
 * it was not us.
 */
export function classifyMinidumpOwnership(
  dumpPath: string,
  appBundleRoot: string,
): MinidumpOwnership {
  const mainModule = readMainModulePath(dumpPath);
  if (mainModule === null) return 'unknown';
  const ours =
    isPathWithinProject(canonicalize(mainModule), canonicalize(appBundleRoot), process.platform) ||
    isPathWithinProject(mainModule, appBundleRoot, process.platform);
  return ours ? 'ours' : 'foreign';
}

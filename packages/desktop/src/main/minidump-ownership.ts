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
 * A pass also lifts the app version Crashpad stamped into the dump, which is
 * the version of the session that DIED — not the one asking. An auto-update
 * between a crash and the next launch is exactly the case where those differ,
 * and it is the reason the version cannot be taken from the running process.
 *
 * The two records are read together, but the two questions are exported
 * separately, so a caller that wants both answers opens the file twice. That
 * is the trade rather than an oversight: ownership decides whether a report
 * may carry process memory at all, and a call whose only return value is the
 * module path keeps the annotation side out of that answer structurally,
 * instead of leaving it a rule somebody has to keep honoring. The annotation
 * walk still runs on that pass — what is constrained is what it can reach, not
 * whether it executes. The price is one extra open of one dump per boot.
 *
 * Reads only the handful of records it needs at explicit file offsets: a
 * minidump is raw process memory and can be hundreds of megabytes, so it must
 * never be slurped whole to answer a path question. No symbolizer, no Crashpad
 * tooling, no Electron.
 */

import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { DISPLAY_LOCK_CRASH_KEY } from '../shared/display-lock-crash-key.ts';
import { asReportableAppVersion } from './crashed-app-version.ts';
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
const DIRECTORY_ENTRY_SIZE_OFFSET = 4;
const DIRECTORY_ENTRY_RVA_OFFSET = 8;
/** `ModuleListStream` in the minidump stream-type enum. */
const MODULE_LIST_STREAM_TYPE = 4;
const MODULE_RECORD_BYTES = 108;
const MODULE_NAME_RVA_OFFSET = 20;
/** `ExceptionStream` in the minidump stream-type enum. */
const EXCEPTION_STREAM_TYPE = 6;
/**
 * `MINIDUMP_EXCEPTION_STREAM` is `ThreadId u32`, `__alignment u32`, then the
 * `MINIDUMP_EXCEPTION` record whose first field is the code.
 */
const EXCEPTION_CODE_OFFSET = 8;
const EXCEPTION_CODE_BYTES = 4;

/**
 * `kMachExceptionSimulated` — `'CPsx'`, raised by `CRASHPAD_SIMULATE_CRASH()`
 * to mean "a dump was captured and the process did NOT fault". Chromium's GPU
 * watchdog takes exactly this path when a GPU thread looks stalled, and may
 * then let the process keep running.
 *
 * Compared for EXACT equality, never as a range, prefix, or family. `'CPnx'`
 * (`0x43506e78`, `kMachExceptionFromNSException`) is one hex digit away, shares
 * the same `CP` tag, and marks a GENUINE fatal crash — so a family match would
 * silently stop reporting real crashes, which is the one failure this predicate
 * exists to avoid.
 *
 * Windows (`0x517a7ed`) and Linux (`kSimulatedSigno`) have their own values.
 * They are deliberately absent from the table below: both are known from
 * Crashpad source but unverified against a real dump on those platforms, where
 * `NumberParameters` and the dump directory's own name both differ. Until one
 * is measured there, those platforms resolve to `null` and the predicate stays
 * inert for them.
 */
const SIMULATED_EXCEPTION_CODE_BY_PLATFORM: Partial<Record<NodeJS.Platform, number>> = {
  darwin: 0x4350_7378,
};

/**
 * Crashpad's flat annotation marking the OTHER non-crash flavor:
 * `DumpProcessWithoutCrashing(task_t)` writes a dump carrying no exception
 * stream at all.
 *
 * Requiring this POSITIVE marker is what keeps that branch honest. A missing
 * exception stream is also what a dump truncated by its own crash looks like,
 * and those must stay reportable — so absence alone can never mean "no crash".
 */
const DUMP_WITHOUT_CRASHING_KEY = 'is-dump-process-without-crashing';

/**
 * `MinidumpCrashpadInfo` — Crashpad's own stream, outside the minidump format's
 * stream-type enum, carrying the annotations the crashing process registered.
 * Its prefix is `version u32`, two 16-byte UUIDs (report id, client id), then
 * the simple-annotation dictionary's `MINIDUMP_LOCATION_DESCRIPTOR`
 * (`dataSize u32, rva u32`) — the last field this parse needs.
 */
const CRASHPAD_INFO_STREAM_TYPE = 0x4350_0001;
const CRASHPAD_ANNOTATIONS_SIZE_OFFSET = 36;
const CRASHPAD_ANNOTATIONS_RVA_OFFSET = 40;
const CRASHPAD_INFO_PREFIX_BYTES = 44;
/**
 * `MinidumpSimpleStringDictionary`: an entry count followed by that many
 * `(keyRva u32, valueRva u32)` pairs, each RVA naming a length-prefixed UTF-8
 * string. Electron registers the app's own version under `_version`; the
 * separate `ver` key holds Electron's, which is not what a triager wants.
 */
const ANNOTATION_ENTRY_BYTES = 8;
const APP_VERSION_ANNOTATION_KEY = '_version';

/**
 * Chromium's crash keys do NOT live in the simple dictionary above.
 *
 * `base::debug::AllocateCrashKeyString` registers into Crashpad's per-module
 * ANNOTATION OBJECT list, a second and entirely separate structure reached
 * through `MinidumpCrashpadInfo.module_list`. Measured on a real OK renderer
 * dump: the simple dictionary held exactly `_productName`, `_version`, `plat`,
 * `prod`, `ver` — Electron's own five — while `ax_mode` sat in the annotation
 * objects of one module alongside `process_type`, `renderer_foreground` and the
 * v8 addresses.
 *
 * Written down because the two structures look interchangeable from a key name
 * and are not: `findSimpleAnnotation` can never return `ax_mode` no matter how
 * well-formed the dump, and the failure is silent — a null that reads exactly
 * like "this dump predates the annotation".
 *
 *   `MinidumpCrashpadInfo.module_list` (a location descriptor at +44/+48)
 *     -> `MinidumpModuleCrashpadInfoList`: count u32, then N links of
 *        `(minidumpModuleListIndex u32, dataSize u32, rva u32)`
 *     -> `MinidumpModuleCrashpadInfo`: version u32, then THREE location
 *        descriptors — list_annotations, simple_annotations, annotation_objects
 *     -> `MinidumpAnnotationList`: count u32, then N of
 *        `(nameRva u32, type u16, reserved u16, valueRva u32)`
 *
 * Name and value are both u32-length-prefixed byte runs, so `readAnnotationString`
 * reads either — but only for `type == kString`; every other type's bytes are
 * not text and must never be decoded as such.
 */
const CRASHPAD_MODULE_LIST_SIZE_OFFSET = 44;
const CRASHPAD_MODULE_LIST_RVA_OFFSET = 48;
/** Through `module_list`, the last field this file reads. Real streams are padded past it. */
const CRASHPAD_INFO_MODULE_LIST_PREFIX_BYTES = 52;
const MODULE_LINK_BYTES = 12;
const MODULE_LINK_RVA_OFFSET = 8;
/** `version u32` followed by three 8-byte location descriptors. */
const MODULE_CRASHPAD_INFO_BYTES = 28;
const MODULE_ANNOTATION_OBJECTS_SIZE_OFFSET = 20;
const MODULE_ANNOTATION_OBJECTS_RVA_OFFSET = 24;
const ANNOTATION_OBJECT_BYTES = 12;
const ANNOTATION_OBJECT_TYPE_OFFSET = 4;
const ANNOTATION_OBJECT_VALUE_RVA_OFFSET = 8;
/** `crashpad::Annotation::Type::kString`. Every other type's value is not text. */
const ANNOTATION_TYPE_STRING = 1;

/**
 * Chromium's crash key for the renderer's live `ui::AXMode`, recorded as the
 * flag names joined by ` | ` — e.g.
 * `kNativeAPIs | kWebContents | kInlineTextBoxes | kExtendedPropert`, cut mid-word
 * because Crashpad caps an annotation at 64 bytes. Truncation is ordinary here,
 * not damage: the flags that decide reachability of the accessibility code paths
 * are the leading ones, and a short tail still names them.
 */
const AX_MODE_ANNOTATION_KEY = 'ax_mode';

/**
 * Chromium's crash key naming which kind of process the dump was written for.
 * Its value tracks the `--type=` switch the process was launched with, so a
 * GPU process records `gpu-process` and a renderer records `renderer`.
 *
 * What the browser process records here is NOT established: it is launched
 * without that switch, and whether the key is then absent or carries some
 * marker of its own has not been measured against a real main-process dump.
 * So a null from this reader means only "this dump did not say", never "this
 * was not a child process" — and no caller may read it as the latter.
 */
const PROCESS_TYPE_ANNOTATION_KEY = 'process_type';

/**
 * Ceilings on every count read out of the file before any allocation. A
 * corrupt or hostile dump can name any u32 here, and a dump is untrusted input
 * for exactly the reason this module exists: it may have been written for a
 * process that is not ours.
 */
const MAX_STREAMS = 4096;
/** Byte length of the UTF-16 module name; real executable paths are far shorter. */
const MAX_MODULE_NAME_BYTES = 8192;
/** Real dumps carry a handful of annotations; this is room to spare, not a target. */
const MAX_ANNOTATIONS = 256;
/** Both keys and values: a version string is tens of bytes. */
const MAX_ANNOTATION_STRING_BYTES = 256;
/** A dump names as many modules as the process loaded; a thousand is a normal count. */
const MAX_MODULE_LINKS = 4096;
/**
 * A whole-walk budget on annotation objects INSPECTED, not a per-list ceiling.
 *
 * The two bounds above are per-record, so on their own they multiply: a dump
 * claiming the maximum links each holding the maximum objects would cost
 * millions of positional reads, on the boot path, for a file we already distrust.
 * One budget across the walk keeps the cost linear in what a real dump contains
 * (one link, a dozen objects) and bounded for everything else. Exhausting it
 * ends the search as "not found", which is the same honest null as a dump that
 * never carried the key.
 */
const MAX_ANNOTATION_OBJECTS_SCANNED = 1024;

/** Exact positional read, or null when the file is shorter than the request. */
function readExactly(fd: number, length: number, position: number): Buffer | null {
  const buf = Buffer.alloc(length);
  return readSync(fd, buf, 0, length, position) === length ? buf : null;
}

/**
 * What one pass over a dump can establish about the process that died. Each
 * record answers for itself: the two live in different streams, so an
 * unreadable one never costs the other.
 */
interface MinidumpFacts {
  /** Path of `ModuleList[0]`, the crashed process's main executable. */
  mainModulePath: string | null;
  /** The crashed process's own app version, from Crashpad's annotations. */
  appVersion: string | null;
  /**
   * The annotation parse threw rather than declining. Nothing a dump can
   * contain reaches that: every bound is checked and every layout the parse
   * distrusts returns null instead. What could is a Crashpad revision this
   * parser no longer recognizes at all — and a regressed parser reads exactly
   * like a dump too old to carry the annotation unless it says otherwise.
   */
  appVersionParseFailed: boolean;
}

const NO_FACTS: MinidumpFacts = Object.freeze({
  mainModulePath: null,
  appVersion: null,
  appVersionParseFailed: false,
});

/** A length-prefixed UTF-8 annotation string, bounded before it is allocated. */
function readAnnotationString(fd: number, rva: number): string | null {
  if (rva === 0) return null;
  const length = readExactly(fd, 4, rva);
  if (length === null) return null;
  const byteLength = length.readUInt32LE(0);
  if (byteLength === 0 || byteLength > MAX_ANNOTATION_STRING_BYTES) return null;
  const bytes = readExactly(fd, byteLength, rva + 4);
  return bytes === null ? null : bytes.toString('utf8');
}

/**
 * The `_version` annotation paired with whether the walk below threw on the way
 * to it. Never throws itself: the caller's other answer must survive anything
 * found here, so a failure stays contained rather than unwinding the whole
 * parse — and the flag is what keeps that containment from also being silent.
 */
function readAppVersionAnnotation(
  fd: number,
  infoRva: number,
  infoSize: number,
): { version: string | null; parseFailed: boolean } {
  try {
    return { version: parseAppVersionAnnotation(fd, infoRva, infoSize), parseFailed: false };
  } catch {
    return { version: null, parseFailed: true };
  }
}

/**
 * The annotation walk itself. Declines by returning null for every layout it
 * distrusts; the caller above owns what happens if it throws anyway.
 */
function parseAppVersionAnnotation(fd: number, infoRva: number, infoSize: number): string | null {
  if (infoSize < CRASHPAD_INFO_PREFIX_BYTES) return null;
  const info = readExactly(fd, CRASHPAD_INFO_PREFIX_BYTES, infoRva);
  if (info === null) return null;
  // Crashpad spells "this dump registered no annotations" as a zero location,
  // which is an ordinary state rather than a damaged one.
  const dictRva = info.readUInt32LE(CRASHPAD_ANNOTATIONS_RVA_OFFSET);
  if (dictRva === 0) return null;
  const count = readExactly(fd, 4, dictRva);
  if (count === null) return null;
  const entryCount = count.readUInt32LE(0);
  if (entryCount === 0 || entryCount > MAX_ANNOTATIONS) return null;
  // The declared block must be large enough to hold the entries it claims.
  // Checked as a floor rather than an equality so a future revision may pad
  // the dictionary without the version silently going dark.
  const declaredBytes = info.readUInt32LE(CRASHPAD_ANNOTATIONS_SIZE_OFFSET);
  if (declaredBytes < 4 + entryCount * ANNOTATION_ENTRY_BYTES) return null;

  const entries = readExactly(fd, entryCount * ANNOTATION_ENTRY_BYTES, dictRva + 4);
  if (entries === null) return null;
  for (let i = 0; i < entryCount; i += 1) {
    const at = i * ANNOTATION_ENTRY_BYTES;
    if (readAnnotationString(fd, entries.readUInt32LE(at)) !== APP_VERSION_ANNOTATION_KEY) {
      continue;
    }
    return asReportableAppVersion(readAnnotationString(fd, entries.readUInt32LE(at + 4)));
  }
  return null;
}

/**
 * Everything this module reads out of `dumpPath`, in one open and one walk of
 * the stream directory.
 */
function readMinidumpFacts(dumpPath: string): MinidumpFacts {
  let fd: number | null = null;
  try {
    fd = openSync(dumpPath, 'r');
    const header = readExactly(fd, HEADER_BYTES, 0);
    if (header === null || header.readUInt32LE(0) !== MINIDUMP_SIGNATURE) return NO_FACTS;
    const streamCount = header.readUInt32LE(NUMBER_OF_STREAMS_OFFSET);
    if (streamCount === 0 || streamCount > MAX_STREAMS) return NO_FACTS;

    const directory = readExactly(
      fd,
      streamCount * DIRECTORY_ENTRY_BYTES,
      header.readUInt32LE(STREAM_DIRECTORY_RVA_OFFSET),
    );
    if (directory === null) return NO_FACTS;
    let moduleListRva: number | null = null;
    let crashpadInfoRva: number | null = null;
    let crashpadInfoSize = 0;
    for (let i = 0; i < streamCount; i += 1) {
      const at = i * DIRECTORY_ENTRY_BYTES;
      const streamType = directory.readUInt32LE(at);
      if (streamType === MODULE_LIST_STREAM_TYPE && moduleListRva === null) {
        moduleListRva = directory.readUInt32LE(at + DIRECTORY_ENTRY_RVA_OFFSET);
      } else if (streamType === CRASHPAD_INFO_STREAM_TYPE && crashpadInfoRva === null) {
        crashpadInfoRva = directory.readUInt32LE(at + DIRECTORY_ENTRY_RVA_OFFSET);
        crashpadInfoSize = directory.readUInt32LE(at + DIRECTORY_ENTRY_SIZE_OFFSET);
      }
      if (moduleListRva !== null && crashpadInfoRva !== null) break;
    }

    const annotation =
      crashpadInfoRva === null
        ? null
        : readAppVersionAnnotation(fd, crashpadInfoRva, crashpadInfoSize);
    return {
      mainModulePath: readMainModule(fd, moduleListRva),
      appVersion: annotation?.version ?? null,
      appVersionParseFailed: annotation?.parseFailed ?? false,
    };
  } catch {
    // Unopenable file, torn read, permissions change mid-scan, or a corrupt
    // dump — all mean the same thing to the caller.
    return NO_FACTS;
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

function readMainModule(fd: number, moduleListRva: number | null): string | null {
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
  const mainModule = readMinidumpFacts(dumpPath).mainModulePath;
  if (mainModule === null) return 'unknown';
  const ours =
    isPathWithinProject(canonicalize(mainModule), canonicalize(appBundleRoot), process.platform) ||
    isPathWithinProject(mainModule, appBundleRoot, process.platform);
  return ours ? 'ours' : 'foreign';
}

export interface MinidumpAppVersionRead {
  /**
   * The app version of the session that wrote the dump, or null when the dump
   * does not name one — an older build that predates the annotation, a dump
   * truncated before its Crashpad stream, or a layout this parser no longer
   * recognizes. Anything non-null already passed `asReportableAppVersion`, and
   * null must be allowed to stay unknown.
   */
  version: string | null;
  /**
   * The parse threw. Separates "this dump has no version to give" from "the
   * parser broke", which are otherwise the same null everywhere downstream and
   * point an investigator in opposite directions.
   */
  parseFailed: boolean;
}

/**
 * Read the app version of the session that wrote `dumpPath`.
 *
 * Only meaningful for a dump this app has not already disowned: Crashpad
 * stamps OUR annotations onto dumps it writes for descendant processes, so a
 * foreign dump carries our version while describing an unrelated program's
 * death. Classify first.
 */
export function readMinidumpAppVersion(dumpPath: string): MinidumpAppVersionRead {
  const facts = readMinidumpFacts(dumpPath);
  return { version: facts.appVersion, parseFailed: facts.appVersionParseFailed };
}

/**
 * Whether the process this dump describes actually faulted.
 *
 * `'indeterminate'` is not an error channel — it is the answer whenever the
 * dump cannot be read well enough to say, and callers are expected to treat it
 * exactly as they treat a crash. Arming therefore keeps failing OPEN: the cost
 * of being wrong is one prompt a user dismisses, where the cost of the opposite
 * default is a real crash nobody ever hears about.
 */
export type MinidumpCrashKind = 'crash' | 'non-crash' | 'indeterminate';

/**
 * Look up one simple annotation by key.
 *
 * Deliberately NOT folded into the app-version walk above. That walk is reached
 * from the same pass as the ownership verdict, and ownership decides whether a
 * report may carry raw process memory at all; keeping this question on its own
 * file handle means a change here cannot reach that answer by accident. The
 * duplication is the point, not an oversight.
 */
function findSimpleAnnotation(
  fd: number,
  infoRva: number,
  infoSize: number,
  key: string,
): string | null {
  if (infoSize < CRASHPAD_INFO_PREFIX_BYTES) return null;
  const info = readExactly(fd, CRASHPAD_INFO_PREFIX_BYTES, infoRva);
  if (info === null) return null;
  const dictRva = info.readUInt32LE(CRASHPAD_ANNOTATIONS_RVA_OFFSET);
  if (dictRva === 0) return null;
  const count = readExactly(fd, 4, dictRva);
  if (count === null) return null;
  const entryCount = count.readUInt32LE(0);
  if (entryCount === 0 || entryCount > MAX_ANNOTATIONS) return null;
  const declaredBytes = info.readUInt32LE(CRASHPAD_ANNOTATIONS_SIZE_OFFSET);
  if (declaredBytes < 4 + entryCount * ANNOTATION_ENTRY_BYTES) return null;

  const entries = readExactly(fd, entryCount * ANNOTATION_ENTRY_BYTES, dictRva + 4);
  if (entries === null) return null;
  for (let i = 0; i < entryCount; i += 1) {
    const at = i * ANNOTATION_ENTRY_BYTES;
    if (readAnnotationString(fd, entries.readUInt32LE(at)) !== key) continue;
    return readAnnotationString(fd, entries.readUInt32LE(at + 4));
  }
  return null;
}

/**
 * Classify `dumpPath` as a real fault, a captured-but-not-crashed snapshot, or
 * unreadable.
 *
 * Four branches, in order:
 *
 *   1. Exception stream present, code EXACTLY the platform sentinel → non-crash.
 *   2. Exception stream present, any other code → crash.
 *   3. No exception stream, directory parsed, AND the positive
 *      `is-dump-process-without-crashing` annotation says `true` → non-crash.
 *   4. Anything else, including any read that fails → indeterminate.
 *
 * Branch 3's annotation requirement is load-bearing. Concluding "no crash" from
 * a MISSING stream would also swallow a dump truncated by the very fault that
 * produced it, which is a real crash nobody would ever be asked about.
 *
 * Returns `'indeterminate'` outright on any platform with no verified sentinel,
 * which leaves that platform's behavior exactly as it was.
 */
export function classifyMinidumpCrashKind(
  dumpPath: string,
  platform: NodeJS.Platform = process.platform,
): MinidumpCrashKind {
  const simulatedCode = SIMULATED_EXCEPTION_CODE_BY_PLATFORM[platform];
  if (simulatedCode === undefined) return 'indeterminate';

  let fd: number | null = null;
  try {
    fd = openSync(dumpPath, 'r');
    const header = readExactly(fd, HEADER_BYTES, 0);
    if (header === null || header.readUInt32LE(0) !== MINIDUMP_SIGNATURE) return 'indeterminate';
    const streamCount = header.readUInt32LE(NUMBER_OF_STREAMS_OFFSET);
    if (streamCount === 0 || streamCount > MAX_STREAMS) return 'indeterminate';

    const directory = readExactly(
      fd,
      streamCount * DIRECTORY_ENTRY_BYTES,
      header.readUInt32LE(STREAM_DIRECTORY_RVA_OFFSET),
    );
    // The directory itself must parse before an absent stream can mean anything.
    if (directory === null) return 'indeterminate';

    let exceptionRva: number | null = null;
    let crashpadInfoRva: number | null = null;
    let crashpadInfoSize = 0;
    for (let i = 0; i < streamCount; i += 1) {
      const at = i * DIRECTORY_ENTRY_BYTES;
      const streamType = directory.readUInt32LE(at);
      if (streamType === EXCEPTION_STREAM_TYPE && exceptionRva === null) {
        exceptionRva = directory.readUInt32LE(at + DIRECTORY_ENTRY_RVA_OFFSET);
      } else if (streamType === CRASHPAD_INFO_STREAM_TYPE && crashpadInfoRva === null) {
        crashpadInfoRva = directory.readUInt32LE(at + DIRECTORY_ENTRY_RVA_OFFSET);
        crashpadInfoSize = directory.readUInt32LE(at + DIRECTORY_ENTRY_SIZE_OFFSET);
      }
      if (exceptionRva !== null && crashpadInfoRva !== null) break;
    }

    if (exceptionRva !== null) {
      const code = readExactly(fd, EXCEPTION_CODE_BYTES, exceptionRva + EXCEPTION_CODE_OFFSET);
      if (code === null) return 'indeterminate';
      return code.readUInt32LE(0) === simulatedCode ? 'non-crash' : 'crash';
    }

    if (crashpadInfoRva === null) return 'indeterminate';
    const marker = findSimpleAnnotation(
      fd,
      crashpadInfoRva,
      crashpadInfoSize,
      DUMP_WITHOUT_CRASHING_KEY,
    );
    return marker === 'true' ? 'non-crash' : 'indeterminate';
  } catch {
    return 'indeterminate';
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

export interface MinidumpAccessibilityModeRead {
  /**
   * Chromium's `ax_mode` crash key as the crashed renderer recorded it, or null
   * when the dump does not carry one.
   *
   * Null is "we do not know", and it must never be read as "accessibility was
   * off". Chromium allocates this key when it first sets an accessibility mode,
   * so a renderer that never had a tree built may register nothing at all — and
   * so may a dump for a process that has no renderer in it, a Chromium revision
   * that renames the key, or a dump truncated before its Crashpad stream. Those
   * are four different situations wearing one null, and the only thing they all
   * rule out is a confident "off".
   *
   * Non-null has already been through `asReportableAnnotationValue`, so it is
   * safe to print on a line of its own.
   */
  mode: string | null;
  /**
   * The walk threw rather than declining. Separates "this dump has no mode to
   * give" from "the parser broke on a layout it no longer recognizes" — the same
   * distinction `MinidumpAppVersionRead.parseFailed` carries, and for the same
   * reason: both reach a reader as one absent field and point in opposite
   * directions.
   */
  parseFailed: boolean;
}

/** Bounds for `asReportableAnnotationValue`; see its contract below. */
const FIRST_PRINTABLE_ASCII = 0x20;
const LAST_PRINTABLE_ASCII = 0x7e;

/**
 * What a Crashpad annotation value must satisfy before it is printed.
 *
 * Deliberately NOT `asReportableAppVersion`. That function's stated contract is
 * that ONE gate decides what a version may be, so its two witnesses can never
 * come to disagree; routing a non-version through it would quietly make it a
 * gate for two different questions sharing one ceiling.
 *
 * The threat is the same one and worth restating: a dump is untrusted input, its
 * every string is attacker-shaped, and the destination is a line-oriented log. A
 * value carrying a line break could forge the context printed around it. Stated
 * as a whitelist because a reject list is always under-enumerated — U+0085,
 * U+2028/U+2029 and the bidi overrides all change how a line renders and none of
 * them is a C0 control.
 *
 * Chromium writes these values with `ui::AXMode`'s flag-name join, printable
 * ASCII by construction, so anything outside that range is not a value this app
 * can vouch for. Length needs no ceiling here: `readAnnotationString` already
 * refuses anything past `MAX_ANNOTATION_STRING_BYTES` before allocating.
 */
function asReportableAnnotationValue(value: string | null): string | null {
  if (value === null || value === '') return null;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < FIRST_PRINTABLE_ASCII || code > LAST_PRINTABLE_ASCII) return null;
  }
  return value;
}

/**
 * One module's annotation objects, searched for `key`. Returns what is left of
 * the scan budget alongside the hit, so the caller's ceiling spans the whole
 * walk instead of resetting at every module.
 */
function findAnnotationObjectInModule(
  fd: number,
  moduleInfoRva: number,
  key: string,
  budget: number,
): { value: string | null; budget: number } {
  const moduleInfo = readExactly(fd, MODULE_CRASHPAD_INFO_BYTES, moduleInfoRva);
  if (moduleInfo === null) return { value: null, budget };
  const listRva = moduleInfo.readUInt32LE(MODULE_ANNOTATION_OBJECTS_RVA_OFFSET);
  // A zero location is how a module with no annotation objects spells it, which
  // is the ordinary state for every module but the one holding the crash keys.
  if (listRva === 0) return { value: null, budget };

  const count = readExactly(fd, 4, listRva);
  if (count === null) return { value: null, budget };
  const objectCount = count.readUInt32LE(0);
  if (objectCount === 0 || objectCount > MAX_ANNOTATIONS) return { value: null, budget };
  // Floor rather than equality, so a future revision may pad the list without
  // this lookup silently going dark.
  const declaredBytes = moduleInfo.readUInt32LE(MODULE_ANNOTATION_OBJECTS_SIZE_OFFSET);
  if (declaredBytes < 4 + objectCount * ANNOTATION_OBJECT_BYTES) return { value: null, budget };

  const objects = readExactly(fd, objectCount * ANNOTATION_OBJECT_BYTES, listRva + 4);
  if (objects === null) return { value: null, budget };

  let remaining = budget;
  for (let i = 0; i < objectCount; i += 1) {
    if (remaining === 0) return { value: null, budget: 0 };
    remaining -= 1;
    const at = i * ANNOTATION_OBJECT_BYTES;
    // Type first: it is a two-byte compare against bytes already in hand, where
    // the name costs a positional read. Screening non-strings here also keeps a
    // colliding key of another type from ever having its bytes decoded as text.
    if (objects.readUInt16LE(at + ANNOTATION_OBJECT_TYPE_OFFSET) !== ANNOTATION_TYPE_STRING) {
      continue;
    }
    if (readAnnotationString(fd, objects.readUInt32LE(at)) !== key) continue;
    const value = readAnnotationString(
      fd,
      objects.readUInt32LE(at + ANNOTATION_OBJECT_VALUE_RVA_OFFSET),
    );
    return { value: asReportableAnnotationValue(value), budget: remaining };
  }
  return { value: null, budget: remaining };
}

/**
 * The walk below paired with whether it threw on the way. Never throws itself:
 * a failure here stays contained rather than unwinding the caller, and the flag
 * is what keeps that containment from also being silent.
 *
 * Deliberately narrower than the caller's own catch. An unopenable file, a torn
 * read or a dump that is not a minidump at all are ordinary states during a scan
 * of a directory Crashpad is also writing to — folding those in would make the
 * flag fire constantly and stop meaning "the parser broke", which is the only
 * thing it is for. Same split as `readAppVersionAnnotation`.
 */
function readModuleAnnotation(
  fd: number,
  infoRva: number,
  infoSize: number,
  key: string,
): { value: string | null; parseFailed: boolean } {
  try {
    return { value: findModuleAnnotation(fd, infoRva, infoSize, key), parseFailed: false };
  } catch {
    return { value: null, parseFailed: true };
  }
}

/** The annotation-object walk. Declines by returning null for any layout it distrusts. */
function findModuleAnnotation(
  fd: number,
  infoRva: number,
  infoSize: number,
  key: string,
): string | null {
  if (infoSize < CRASHPAD_INFO_MODULE_LIST_PREFIX_BYTES) return null;
  const info = readExactly(fd, CRASHPAD_INFO_MODULE_LIST_PREFIX_BYTES, infoRva);
  if (info === null) return null;
  const listRva = info.readUInt32LE(CRASHPAD_MODULE_LIST_RVA_OFFSET);
  if (listRva === 0) return null;

  const count = readExactly(fd, 4, listRva);
  if (count === null) return null;
  const linkCount = count.readUInt32LE(0);
  if (linkCount === 0 || linkCount > MAX_MODULE_LINKS) return null;
  const declaredBytes = info.readUInt32LE(CRASHPAD_MODULE_LIST_SIZE_OFFSET);
  if (declaredBytes < 4 + linkCount * MODULE_LINK_BYTES) return null;

  const links = readExactly(fd, linkCount * MODULE_LINK_BYTES, listRva + 4);
  if (links === null) return null;

  // Every link is searched rather than a known index: WHICH module carries
  // Chromium's crash keys is a build detail — the framework, not the executable
  // the ownership parse reads — and pinning an index would silently stop
  // answering the first time a build reorders its module list.
  let budget = MAX_ANNOTATION_OBJECTS_SCANNED;
  for (let i = 0; i < linkCount; i += 1) {
    const found = findAnnotationObjectInModule(
      fd,
      links.readUInt32LE(i * MODULE_LINK_BYTES + MODULE_LINK_RVA_OFFSET),
      key,
      budget,
    );
    if (found.value !== null) return found.value;
    budget = found.budget;
    if (budget === 0) return null;
  }
  return null;
}

/**
 * Read the accessibility mode the process described by `dumpPath` was running
 * with when it died.
 *
 * This is the recorded answer to the precondition a whole family of Blink
 * accessibility `CHECK` crashes turns on — `AXBlockFlowData::ComputeNeighborOnLine`
 * and its neighbours are reachable only with a live accessibility tree, and the
 * app's own `OK_FORCE_A11Y` switch is opt-in, so without this the tree's
 * presence can only ever be inferred from circumstance. Chromium has been
 * recording it on every dump all along; nothing was reading it.
 *
 * Opens its own descriptor rather than riding the ownership pass, for the same
 * reason `findSimpleAnnotation` does: ownership decides whether a report may
 * carry raw process memory at all, and keeping this question on its own handle
 * means a change here cannot reach that answer by accident.
 *
 * Like `readMinidumpAppVersion`, only meaningful for a dump this app has not
 * already disowned — Crashpad stamps our annotations onto dumps it writes for
 * descendant processes. Classify first.
 */
export function readMinidumpAccessibilityMode(dumpPath: string): MinidumpAccessibilityModeRead {
  const read = readDumpAnnotation(dumpPath, AX_MODE_ANNOTATION_KEY);
  return { mode: read.value, parseFailed: read.parseFailed };
}

export interface MinidumpProcessTypeRead {
  /**
   * Chromium's `process_type` crash key — `gpu-process`, `renderer`, `utility`
   * and so on — or null when the dump carries none.
   *
   * Null is "the dump does not say", never "some other kind of process". The
   * browser process carries no `--type=` switch and therefore no key, and a
   * dump truncated before its Crashpad stream reads the same way.
   */
  processType: string | null;
  /**
   * The walk threw rather than declining, the same split the sibling readers
   * carry: one absent field, two opposite conclusions.
   */
  parseFailed: boolean;
}

/**
 * Read which kind of process `dumpPath` was written for.
 *
 * Read so that a death this app deliberately declined to prompt for can be
 * paired with the dump it produced at the next boot, rather than that dump
 * being mistaken for an unreported crash — see `crash-detection.ts`. The
 * pairing is what keeps the retirement narrow: a GPU death that was swallowed
 * on purpose retires a GPU dump and nothing else.
 *
 * Like `readMinidumpAppVersion`, only meaningful for a dump this app has not
 * already disowned. Classify first.
 */
export function readMinidumpProcessType(dumpPath: string): MinidumpProcessTypeRead {
  const read = readDumpAnnotation(dumpPath, PROCESS_TYPE_ANNOTATION_KEY);
  return { processType: read.value, parseFailed: read.parseFailed };
}

/**
 * Walk `dumpPath`'s Crashpad stream and return the annotation stored under
 * `key`, or null when the dump carries none.
 *
 * Shared by every annotation reader here so the minidump traversal — signature
 * check, stream-count ceiling, directory read, Crashpad-stream selection — has
 * one implementation rather than one per key. The value/parseFailed split is
 * the callers' contract: null with `parseFailed: false` is "the dump does not
 * say", null with `parseFailed: true` is "the parser broke".
 */
function readDumpAnnotation(
  dumpPath: string,
  key: string,
): { value: string | null; parseFailed: boolean } {
  let fd: number | null = null;
  try {
    fd = openSync(dumpPath, 'r');
    const header = readExactly(fd, HEADER_BYTES, 0);
    if (header === null || header.readUInt32LE(0) !== MINIDUMP_SIGNATURE) {
      return { value: null, parseFailed: false };
    }
    const streamCount = header.readUInt32LE(NUMBER_OF_STREAMS_OFFSET);
    if (streamCount === 0 || streamCount > MAX_STREAMS) return { value: null, parseFailed: false };

    const directory = readExactly(
      fd,
      streamCount * DIRECTORY_ENTRY_BYTES,
      header.readUInt32LE(STREAM_DIRECTORY_RVA_OFFSET),
    );
    if (directory === null) return { value: null, parseFailed: false };

    for (let i = 0; i < streamCount; i += 1) {
      const at = i * DIRECTORY_ENTRY_BYTES;
      if (directory.readUInt32LE(at) !== CRASHPAD_INFO_STREAM_TYPE) continue;
      return readModuleAnnotation(
        fd,
        directory.readUInt32LE(at + DIRECTORY_ENTRY_RVA_OFFSET),
        directory.readUInt32LE(at + DIRECTORY_ENTRY_SIZE_OFFSET),
        key,
      );
    }
    return { value: null, parseFailed: false };
  } catch {
    // Unopenable file, torn read, permissions change mid-scan, or a dump that
    // is not a minidump — none of which is a broken parser, so none of which
    // sets the flag. Matches what `readMinidumpFacts` does with the same shapes.
    return { value: null, parseFailed: false };
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

export interface MinidumpDisplayLockRead {
  /**
   * OK's `ok_display_lock` crash key as the crashed renderer last published it,
   * or null when the dump does not carry one.
   *
   * Null is "we do not know", never "no display lock was active". A renderer
   * that died before the editor mounted never published a value; so does a dump
   * for a process with no renderer in it, a build predating the key, and a dump
   * truncated before its Crashpad stream. The only thing null rules out is a
   * confident "nothing was locked".
   *
   * What a NON-null value means, since it is equally easy to over-read. The
   * shape is `v1 lock=<0|1> f=<n> n=<n> s=<0|1>`, written by the app's
   * `display-lock-crash-key` reporter, and it describes `.ok-chunk-wrapper`
   * (`content-visibility: auto`) transitions ONLY. The other display-lock site,
   * `.ok-mode-hidden`, is `content-visibility: hidden` and cannot fire the
   * event this is built on, so a crash there carries whatever the chunk
   * wrappers last did and says nothing about the pane.
   *
   * `s` is the field that dates the reading: `s=0` means a transition burst was
   * still in flight when the process died, `s=1` means the last burst had
   * already settled and the rest of the value is residue rather than something
   * that coincided with the crash.
   */
  state: string | null;
  /** True only when the parser itself threw, which is a bug in this module. */
  parseFailed: boolean;
}

/**
 * Read OK's display-lock crash key out of `dumpPath`.
 *
 * Same ownership caveat as `readMinidumpAccessibilityMode`: call this only on a
 * dump already classified as ours, because Crashpad stamps our annotations onto
 * dumps it writes for descendant processes too.
 */
export function readMinidumpDisplayLockState(dumpPath: string): MinidumpDisplayLockRead {
  const read = readDumpAnnotation(dumpPath, DISPLAY_LOCK_CRASH_KEY);
  return { state: read.value, parseFailed: read.parseFailed };
}

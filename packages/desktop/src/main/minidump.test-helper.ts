/**
 * Synthetic minidump builder shared by the ownership tests.
 *
 * Produces the smallest buffer the ownership parse can read: header, a
 * one-entry stream directory, a ModuleList, and the module-name strings. Real
 * dumps carry dozens of streams and hundreds of modules; ownership only reads
 * `ModuleList[0]`, so nothing else needs to exist.
 *
 * Built in-test rather than committed as a binary fixture — a blob nobody can
 * diff would hide which field the parse actually depends on, and the malformed
 * variants below are the point: every offset the parser trusts is reachable
 * here as a `patch` field, so a test can lie about exactly one of them and
 * leave the rest well-formed.
 */

const HEADER_BYTES = 32;
const DIRECTORY_ENTRY_BYTES = 12;
const MODULE_RECORD_BYTES = 108;
const MODULE_NAME_RVA_OFFSET = 20;
const MODULE_LIST_STREAM_TYPE = 4;
const CRASHPAD_INFO_STREAM_TYPE = 0x4350_0001;
/** Real dumps size this stream at 64 bytes; the parse reads only the first 44. */
const CRASHPAD_INFO_BYTES = 64;
const CRASHPAD_ANNOTATIONS_SIZE_OFFSET = 36;
const CRASHPAD_ANNOTATIONS_RVA_OFFSET = 40;
const ANNOTATION_ENTRY_BYTES = 8;
const EXCEPTION_STREAM_TYPE = 6;
/**
 * `MINIDUMP_EXCEPTION_STREAM`: `ThreadId u32`, `__alignment u32`, the 152-byte
 * `MINIDUMP_EXCEPTION` record, then a `MINIDUMP_LOCATION_DESCRIPTOR` for the
 * thread context. Only the code is read here, but the stream is emitted at its
 * true size so a fixture cannot pass by being conveniently short.
 *
 * `ExceptionInformation` is a FIXED 15-entry array, not one sized by
 * `NumberParameters` — advancing by the latter is a documented way to misparse
 * this record.
 */
const EXCEPTION_STREAM_BYTES = 168;
const EXCEPTION_CODE_OFFSET = 8;

/**
 * Per-field overrides. Most corrupt a single value the parser reads;
 * `annotations` instead adds a stream that is absent by default, so every
 * fixture written before it existed stays byte-identical and keeps covering
 * the dump-carries-no-annotations path for free.
 *
 * The annotation lies below all target the FIRST dictionary entry, so a case
 * that exercises one should pass a single-entry `annotations` map.
 */
export interface MinidumpPatch {
  /** Header magic. Anything but `MDMP` must be refused outright. */
  signature?: string;
  /** Header's claimed stream count, independent of what the directory holds. */
  streamCount?: number;
  /** Header's pointer to the stream directory. */
  streamDirectoryRva?: number;
  /** Directory entry's stream type; anything but 4 hides the ModuleList. */
  streamType?: number;
  /** Directory entry's pointer to the ModuleList. */
  moduleListRva?: number;
  /** ModuleList's claimed module count. */
  moduleCount?: number;
  /** `ModuleList[0]`'s pointer to its name block. */
  nameRva?: number;
  /** The name block's claimed BYTE length (not code units). */
  nameByteLength?: number;
  /** Cut the finished buffer here, simulating a dump the crash truncated. */
  truncateTo?: number;
  /**
   * Prepend this many non-ModuleList directory entries. Real Crashpad dumps
   * carry ThreadList, MemoryList, ExceptionStream and friends ahead of the
   * ModuleList, so the parser's search has to walk past them; with a
   * single-entry directory it would only ever be exercised at index 0.
   */
  streamsBefore?: number;
  /**
   * Crashpad simple annotations to carry. Omitted entirely when absent — no
   * Crashpad stream is emitted at all, which is what a dump from a build
   * predating them looks like.
   */
  annotations?: Record<string, string>;
  /** Crashpad stream's directory type; anything else hides the annotations. */
  crashpadStreamType?: number;
  /** Crashpad info's pointer to the annotation dictionary; 0 means "none registered". */
  annotationsRva?: number;
  /** Crashpad info's claimed byte size for the dictionary block. */
  annotationsSize?: number;
  /** The dictionary's claimed entry count, independent of what it holds. */
  annotationCount?: number;
  /** First entry's pointer to its key string. */
  annotationKeyRva?: number;
  /** First entry's pointer to its value string. */
  annotationValueRva?: number;
  /** First entry's value block's claimed BYTE length. */
  annotationValueByteLength?: number;
  /**
   * Emit an ExceptionStream carrying this code. Omitted entirely when absent,
   * which is what both a pre-exception-stream dump and the
   * `DumpProcessWithoutCrashing` flavor look like — so the crash-kind parse has
   * to distinguish those by annotation rather than by the stream's absence.
   */
  exceptionCode?: number;
}

export function buildMinidump(modulePaths: string[], patch: MinidumpPatch = {}): Buffer {
  const decoyStreams = patch.streamsBefore ?? 0;
  const annotationEntries =
    patch.annotations === undefined ? null : Object.entries(patch.annotations);
  const hasException = patch.exceptionCode !== undefined;
  const directoryEntries =
    decoyStreams + 1 + (annotationEntries === null ? 0 : 1) + (hasException ? 1 : 0);
  const directoryRva = HEADER_BYTES;
  const moduleListRva = directoryRva + directoryEntries * DIRECTORY_ENTRY_BYTES;
  const moduleListBytes = 4 + modulePaths.length * MODULE_RECORD_BYTES;

  // Names are laid out after the module records, so every record's name RVA
  // points forward into this block.
  const nameBlocks: Buffer[] = [];
  const nameRvas: number[] = [];
  let cursor = moduleListRva + moduleListBytes;
  for (const modulePath of modulePaths) {
    const encoded = Buffer.from(modulePath, 'utf16le');
    const block = Buffer.alloc(4 + encoded.length);
    block.writeUInt32LE(encoded.length, 0);
    encoded.copy(block, 4);
    nameBlocks.push(block);
    nameRvas.push(cursor);
    cursor += block.length;
  }
  const firstName = nameBlocks[0];
  if (patch.nameByteLength !== undefined && firstName !== undefined) {
    firstName.writeUInt32LE(patch.nameByteLength, 0);
  }

  // Crashpad's own stream, laid out after the module names: the fixed-size
  // info record, then the dictionary of (key rva, value rva) pairs, then the
  // strings those point at. Each string is a byte length that EXCLUDES the
  // trailing NUL, the UTF-8 bytes, then that NUL — as real dumps write them.
  const crashpadBlocks: Buffer[] = [];
  const crashpadInfoRva = cursor;
  if (annotationEntries !== null) {
    const dictRva = crashpadInfoRva + CRASHPAD_INFO_BYTES;
    const dictBytes = 4 + annotationEntries.length * ANNOTATION_ENTRY_BYTES;
    const stringBlocks: Buffer[] = [];
    let stringCursor = dictRva + dictBytes;
    const appendString = (value: string): { rva: number; block: Buffer } => {
      const encoded = Buffer.from(value, 'utf8');
      const block = Buffer.alloc(4 + encoded.length + 1);
      block.writeUInt32LE(encoded.length, 0);
      encoded.copy(block, 4);
      const rva = stringCursor;
      stringBlocks.push(block);
      stringCursor += block.length;
      return { rva, block };
    };

    const dict = Buffer.alloc(dictBytes);
    dict.writeUInt32LE(patch.annotationCount ?? annotationEntries.length, 0);
    annotationEntries.forEach(([key, value], index) => {
      const keyString = appendString(key);
      const valueString = appendString(value);
      const at = 4 + index * ANNOTATION_ENTRY_BYTES;
      const first = index === 0;
      dict.writeUInt32LE(first ? (patch.annotationKeyRva ?? keyString.rva) : keyString.rva, at);
      dict.writeUInt32LE(
        first ? (patch.annotationValueRva ?? valueString.rva) : valueString.rva,
        at + 4,
      );
      if (first && patch.annotationValueByteLength !== undefined) {
        valueString.block.writeUInt32LE(patch.annotationValueByteLength, 0);
      }
    });

    const info = Buffer.alloc(CRASHPAD_INFO_BYTES);
    info.writeUInt32LE(1, 0); // struct version — unread by this parse
    info.writeUInt32LE(patch.annotationsSize ?? dictBytes, CRASHPAD_ANNOTATIONS_SIZE_OFFSET);
    info.writeUInt32LE(patch.annotationsRva ?? dictRva, CRASHPAD_ANNOTATIONS_RVA_OFFSET);
    crashpadBlocks.push(info, dict, ...stringBlocks);
    cursor = stringCursor;
  }

  // Laid out last so adding one cannot shift any offset an existing fixture
  // already depends on.
  const exceptionBlocks: Buffer[] = [];
  const exceptionRva = cursor;
  if (hasException) {
    const exception = Buffer.alloc(EXCEPTION_STREAM_BYTES);
    exception.writeUInt32LE(1, 0); // ThreadId — unread by the crash-kind parse
    exception.writeUInt32LE(patch.exceptionCode ?? 0, EXCEPTION_CODE_OFFSET);
    exceptionBlocks.push(exception);
    cursor += EXCEPTION_STREAM_BYTES;
  }

  const header = Buffer.alloc(HEADER_BYTES);
  header.write(patch.signature ?? 'MDMP', 0, 'ascii');
  header.writeUInt32LE(0xa793, 4); // version — unread by the ownership parse
  header.writeUInt32LE(patch.streamCount ?? directoryEntries, 8);
  header.writeUInt32LE(patch.streamDirectoryRva ?? directoryRva, 12);

  // Decoys first, ModuleList last, so a parser that only inspects entry 0
  // fails these fixtures instead of passing them by accident.
  const directory = Buffer.alloc(directoryEntries * DIRECTORY_ENTRY_BYTES);
  for (let i = 0; i < decoyStreams; i += 1) {
    // 3 = ThreadListStream; the type only has to not be ModuleList.
    directory.writeUInt32LE(3, i * DIRECTORY_ENTRY_BYTES);
  }
  const moduleListEntry = decoyStreams * DIRECTORY_ENTRY_BYTES;
  directory.writeUInt32LE(patch.streamType ?? MODULE_LIST_STREAM_TYPE, moduleListEntry);
  directory.writeUInt32LE(moduleListBytes, moduleListEntry + 4);
  directory.writeUInt32LE(patch.moduleListRva ?? moduleListRva, moduleListEntry + 8);
  let nextEntry = moduleListEntry + DIRECTORY_ENTRY_BYTES;
  if (annotationEntries !== null) {
    directory.writeUInt32LE(patch.crashpadStreamType ?? CRASHPAD_INFO_STREAM_TYPE, nextEntry);
    directory.writeUInt32LE(CRASHPAD_INFO_BYTES, nextEntry + 4);
    directory.writeUInt32LE(crashpadInfoRva, nextEntry + 8);
    nextEntry += DIRECTORY_ENTRY_BYTES;
  }
  if (hasException) {
    directory.writeUInt32LE(EXCEPTION_STREAM_TYPE, nextEntry);
    directory.writeUInt32LE(EXCEPTION_STREAM_BYTES, nextEntry + 4);
    directory.writeUInt32LE(exceptionRva, nextEntry + 8);
    nextEntry += DIRECTORY_ENTRY_BYTES;
  }

  const moduleList = Buffer.alloc(moduleListBytes);
  moduleList.writeUInt32LE(patch.moduleCount ?? modulePaths.length, 0);
  nameRvas.forEach((rva, index) => {
    const at = 4 + index * MODULE_RECORD_BYTES + MODULE_NAME_RVA_OFFSET;
    moduleList.writeUInt32LE(index === 0 ? (patch.nameRva ?? rva) : rva, at);
  });

  const dump = Buffer.concat([
    header,
    directory,
    moduleList,
    ...nameBlocks,
    ...crashpadBlocks,
    ...exceptionBlocks,
  ]);
  return patch.truncateTo === undefined ? dump : dump.subarray(0, patch.truncateTo);
}

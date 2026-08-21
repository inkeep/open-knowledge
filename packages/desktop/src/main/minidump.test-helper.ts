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
/**
 * Real dumps size this stream at 64 bytes — measured, not assumed — while the
 * struct through its last read field is 52. Emitted at the real size so a
 * fixture cannot pass by being conveniently short of the padding.
 */
const CRASHPAD_INFO_BYTES = 64;
const CRASHPAD_ANNOTATIONS_SIZE_OFFSET = 36;
const CRASHPAD_ANNOTATIONS_RVA_OFFSET = 40;
const ANNOTATION_ENTRY_BYTES = 8;
/**
 * The SECOND annotation structure, reached through `MinidumpCrashpadInfo.module_list`
 * rather than the simple dictionary above — where Chromium's own crash keys
 * (`ax_mode`, `process_type`, …) actually live. Emitting it takes three nested
 * records:
 *
 *   `MinidumpModuleCrashpadInfoList` — count, then N `(moduleIndex, size, rva)` links
 *   `MinidumpModuleCrashpadInfo`     — version, then list/simple/objects descriptors
 *   `MinidumpAnnotationList`         — count, then N `(nameRva, type, reserved, valueRva)`
 */
const CRASHPAD_MODULE_LIST_SIZE_OFFSET = 44;
const CRASHPAD_MODULE_LIST_RVA_OFFSET = 48;
const MODULE_LINK_BYTES = 12;
const MODULE_CRASHPAD_INFO_BYTES = 28;
const MODULE_ANNOTATION_OBJECTS_SIZE_OFFSET = 20;
const MODULE_ANNOTATION_OBJECTS_RVA_OFFSET = 24;
const ANNOTATION_OBJECT_BYTES = 12;
const ANNOTATION_OBJECT_TYPE_OFFSET = 4;
const ANNOTATION_OBJECT_VALUE_RVA_OFFSET = 8;
/** `crashpad::Annotation::Type::kString`. */
const ANNOTATION_TYPE_STRING = 1;
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
  /**
   * Per-module annotation OBJECTS — one map per module link, so the array's
   * length is the number of links. An empty map emits a module carrying no
   * objects at all, which is what every module but one looks like in a real
   * dump and is exactly what a walk that stops at the first link would skip.
   *
   * Absent by default, so every fixture written before it existed stays
   * byte-identical: the info record's module-list descriptor simply stays zero,
   * which is what a dump registering no module annotations looks like.
   *
   * Independent of `annotations`: either may appear without the other, because
   * the two are separate structures and a parser must not reach one through the
   * other.
   */
  annotationObjects?: Record<string, string>[];
  /** The link list's claimed count, independent of how many links follow it. */
  moduleLinkCount?: number;
  /** Crashpad info's pointer to the link list; 0 means "no module annotations". */
  crashpadModuleListRva?: number;
  /** Crashpad info's claimed byte size for the link-list block. */
  crashpadModuleListSize?: number;
  /** FIRST module's claimed object count, independent of what it holds. */
  annotationObjectCount?: number;
  /** FIRST module's pointer to its annotation-object list; 0 means "none". */
  annotationObjectsRva?: number;
  /** FIRST module's claimed byte size for its object-list block. */
  annotationObjectsSize?: number;
  /**
   * FIRST object's type tag. Anything but `kString` (1) marks a value whose
   * bytes are not text, and must never be decoded as such.
   */
  annotationObjectType?: number;
  /** FIRST object's pointer to its value block. */
  annotationObjectValueRva?: number;
  /** FIRST object's value block's claimed BYTE length. */
  annotationObjectValueByteLength?: number;
}

export function buildMinidump(modulePaths: string[], patch: MinidumpPatch = {}): Buffer {
  const decoyStreams = patch.streamsBefore ?? 0;
  const annotationEntries =
    patch.annotations === undefined ? null : Object.entries(patch.annotations);
  const objectModules = patch.annotationObjects ?? null;
  // ONE stream carries both structures, so it is emitted for either — but each
  // section fills in only its own descriptor, which is what lets a fixture
  // carry module annotations with no simple dictionary and the other way round.
  const hasCrashpadStream = annotationEntries !== null || objectModules !== null;
  const hasException = patch.exceptionCode !== undefined;
  const directoryEntries = decoyStreams + 1 + (hasCrashpadStream ? 1 : 0) + (hasException ? 1 : 0);
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
  if (hasCrashpadStream) {
    // One info record carries BOTH descriptors, so each section below fills in
    // its own and leaves the other's zero — which is how a real dump spells
    // "registered none of that kind".
    const info = Buffer.alloc(CRASHPAD_INFO_BYTES);
    info.writeUInt32LE(1, 0); // struct version — unread by this parse
    crashpadBlocks.push(info);
    cursor = crashpadInfoRva + CRASHPAD_INFO_BYTES;

    if (annotationEntries !== null) {
      const dictRva = cursor;
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

      info.writeUInt32LE(patch.annotationsSize ?? dictBytes, CRASHPAD_ANNOTATIONS_SIZE_OFFSET);
      info.writeUInt32LE(patch.annotationsRva ?? dictRva, CRASHPAD_ANNOTATIONS_RVA_OFFSET);
      crashpadBlocks.push(dict, ...stringBlocks);
      cursor = stringCursor;
    }

    if (objectModules !== null) {
      // Laid out in three runs — every link, then every module record, then
      // every object list — so a record's forward pointers are all computable
      // before any of them is written.
      const linkListRva = cursor;
      const linkListBytes = 4 + objectModules.length * MODULE_LINK_BYTES;
      const moduleInfoRva = (i: number) =>
        linkListRva + linkListBytes + i * MODULE_CRASHPAD_INFO_BYTES;
      const objectListBytes = objectModules.map(
        (objects) => 4 + Object.keys(objects).length * ANNOTATION_OBJECT_BYTES,
      );
      const objectListsRva =
        linkListRva + linkListBytes + objectModules.length * MODULE_CRASHPAD_INFO_BYTES;
      const objectListRva = (i: number) =>
        objectListsRva + objectListBytes.slice(0, i).reduce((a, b) => a + b, 0);

      const stringBlocks: Buffer[] = [];
      let stringCursor = objectListsRva + objectListBytes.reduce((a, b) => a + b, 0);
      /**
       * A name is a NUL-terminated `MinidumpUTF8String`; a value is a bare
       * `MinidumpByteArray`. Both are u32-length-prefixed and the length
       * excludes any NUL, so the reader sees the same shape either way — the
       * distinction is kept because the dumps being imitated keep it.
       */
      const appendString = (value: string, nulTerminated: boolean) => {
        const encoded = Buffer.from(value, 'utf8');
        const block = Buffer.alloc(4 + encoded.length + (nulTerminated ? 1 : 0));
        block.writeUInt32LE(encoded.length, 0);
        encoded.copy(block, 4);
        const rva = stringCursor;
        stringBlocks.push(block);
        stringCursor += block.length;
        return { rva, block };
      };

      const linkList = Buffer.alloc(linkListBytes);
      linkList.writeUInt32LE(patch.moduleLinkCount ?? objectModules.length, 0);
      const moduleInfos: Buffer[] = [];
      const objectLists: Buffer[] = [];

      objectModules.forEach((objects, moduleIndex) => {
        const firstModule = moduleIndex === 0;
        const at = 4 + moduleIndex * MODULE_LINK_BYTES;
        // Index 0 is the main executable and never carries Chromium's crash
        // keys; starting at 1 mirrors what real dumps do.
        linkList.writeUInt32LE(moduleIndex + 1, at);
        linkList.writeUInt32LE(MODULE_CRASHPAD_INFO_BYTES, at + 4);
        linkList.writeUInt32LE(moduleInfoRva(moduleIndex), at + 8);

        const entries = Object.entries(objects);
        const list = Buffer.alloc(objectListBytes[moduleIndex] ?? 4);
        list.writeUInt32LE(
          firstModule ? (patch.annotationObjectCount ?? entries.length) : entries.length,
          0,
        );
        entries.forEach(([key, value], index) => {
          const first = firstModule && index === 0;
          const name = appendString(key, true);
          const valueBlock = appendString(value, false);
          const objAt = 4 + index * ANNOTATION_OBJECT_BYTES;
          list.writeUInt32LE(name.rva, objAt);
          list.writeUInt16LE(
            first ? (patch.annotationObjectType ?? ANNOTATION_TYPE_STRING) : ANNOTATION_TYPE_STRING,
            objAt + ANNOTATION_OBJECT_TYPE_OFFSET,
          );
          list.writeUInt32LE(
            first ? (patch.annotationObjectValueRva ?? valueBlock.rva) : valueBlock.rva,
            objAt + ANNOTATION_OBJECT_VALUE_RVA_OFFSET,
          );
          if (first && patch.annotationObjectValueByteLength !== undefined) {
            valueBlock.block.writeUInt32LE(patch.annotationObjectValueByteLength, 0);
          }
        });
        objectLists.push(list);

        const moduleInfo = Buffer.alloc(MODULE_CRASHPAD_INFO_BYTES);
        moduleInfo.writeUInt32LE(1, 0); // struct version — unread by this parse
        // An empty map means "this module registered no objects", spelled the
        // way Crashpad spells it: a zero location, not an empty list.
        const hasObjects = entries.length > 0;
        const declaredSize = firstModule
          ? (patch.annotationObjectsSize ?? objectListBytes[moduleIndex] ?? 0)
          : (objectListBytes[moduleIndex] ?? 0);
        const declaredRva = firstModule
          ? (patch.annotationObjectsRva ?? (hasObjects ? objectListRva(moduleIndex) : 0))
          : hasObjects
            ? objectListRva(moduleIndex)
            : 0;
        moduleInfo.writeUInt32LE(
          hasObjects || firstModule ? declaredSize : 0,
          MODULE_ANNOTATION_OBJECTS_SIZE_OFFSET,
        );
        moduleInfo.writeUInt32LE(declaredRva, MODULE_ANNOTATION_OBJECTS_RVA_OFFSET);
        moduleInfos.push(moduleInfo);
      });

      info.writeUInt32LE(
        patch.crashpadModuleListSize ?? linkListBytes,
        CRASHPAD_MODULE_LIST_SIZE_OFFSET,
      );
      info.writeUInt32LE(
        patch.crashpadModuleListRva ?? linkListRva,
        CRASHPAD_MODULE_LIST_RVA_OFFSET,
      );
      crashpadBlocks.push(linkList, ...moduleInfos, ...objectLists, ...stringBlocks);
      cursor = stringCursor;
    }
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
  if (hasCrashpadStream) {
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

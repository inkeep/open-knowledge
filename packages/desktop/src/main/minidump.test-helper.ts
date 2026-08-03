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

/** Per-field overrides; each one corrupts a single value the parser reads. */
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
}

export function buildMinidump(modulePaths: string[], patch: MinidumpPatch = {}): Buffer {
  const decoyStreams = patch.streamsBefore ?? 0;
  const directoryEntries = decoyStreams + 1;
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

  const moduleList = Buffer.alloc(moduleListBytes);
  moduleList.writeUInt32LE(patch.moduleCount ?? modulePaths.length, 0);
  nameRvas.forEach((rva, index) => {
    const at = 4 + index * MODULE_RECORD_BYTES + MODULE_NAME_RVA_OFFSET;
    moduleList.writeUInt32LE(index === 0 ? (patch.nameRva ?? rva) : rva, at);
  });

  const dump = Buffer.concat([header, directory, moduleList, ...nameBlocks]);
  return patch.truncateTo === undefined ? dump : dump.subarray(0, patch.truncateTo);
}

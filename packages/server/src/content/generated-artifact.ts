/**
 * Writing a document OK authors itself.
 *
 * The generated root `index.md` is the first of these; the shape is deliberately
 * not about indexes. What an artifact IS — which documents it lists, when it is
 * worth rebuilding — belongs to the artifact. What every artifact shares is the
 * awkward part: a generated file can be open in an editor, so there are two
 * write paths, and each carries bookkeeping that is easy to omit and silent when
 * omitted.
 *
 * Three things live here because getting any of them wrong fails quietly:
 *
 *   - **The fixed point.** Identical bytes perform NO write — not a rewrite with
 *     the same content. Writing mutates the file index and signals `files`, both
 *     of which are trigger surfaces, so an unconditional writer keeps a tracked
 *     file permanently dirty and, if a future trigger ever fires on its own
 *     write, spins.
 *   - **The path split.** A resident document is written through the CRDT so the
 *     open editor converges; going to disk behind its back would leave it on
 *     stale bytes until something else reconciled it. A doc that is not resident
 *     has no CRDT to be authoritative, so disk plus its bookkeeping is the job.
 *   - **Authorship.** The bytes reach the commit either way — the shadow repo's
 *     tree is a sweep of the whole content root — but the CREDIT comes only from
 *     an explicit contributor record. Without one they land under whichever
 *     writer drains next, which is a human when someone has the file open.
 *
 * The caller supplies the collaborators rather than importing them, so the whole
 * dispatch is exercisable without booting a server.
 */

import type * as Y from 'yjs';
import { replaceRawBody } from '../bridge-intake.ts';
import type { PairedWriteOrigin } from '../server-observers.ts';
import type { WriterIdentity } from '../shadow-repo.ts';

/** The bounded result of a write attempt, including deliberate conflict refusal. */
export type GeneratedWriteOutcome = 'unchanged' | 'document' | 'disk' | 'blocked-conflict';

export interface GeneratedArtifactEnv {
  /**
   * The origin for the CRDT branch. Typed rather than loose because the static
   * scan that audits paired writes cannot resolve a parameter — this type is
   * what keeps the `paired: true` requirement enforced at the seam.
   */
  origin: PairedWriteOrigin;
  /** Who the write is credited to. */
  writer: WriterIdentity;
  /** Whether the authoritative conflict registry currently owns this doc. */
  isConflict(docName: string): boolean;
  /** The resident document for a docName, or undefined when it is not loaded. */
  getDocument(docName: string): Y.Doc | undefined;
  /** Create the parent directory and atomically publish the file. */
  writeDisk(absPath: string, markdown: string): void | Promise<void>;
  /**
   * Tell the watcher this write was ours so it does not re-enter as an external
   * change. Disk path only — the CRDT path reaches disk through persistence,
   * which does its own registration.
   */
  registerWrite(absPath: string, markdown: string): void;
  /** Keep the in-memory file index in step with the write we just did. */
  noteFileIndex(event: {
    kind: 'create' | 'update';
    absPath: string;
    docName: string;
    markdown: string;
  }): void;
  /** Broadcast that the file set changed. */
  signalFiles(): void;
  /** Claim the write for `writer`, then push it to the shadow repo. */
  attribute(docName: string, writer: WriterIdentity): Promise<void>;
}

export interface GeneratedArtifactWrite {
  /** Extension-less docName (`index`), as every docName is. */
  docName: string;
  /** Absolute path the docName resolves to. */
  absPath: string;
  /** The bytes the artifact should hold. */
  markdown: string;
  /** What is on disk now, or null when the file does not exist yet. */
  currentMarkdown: string | null;
}

/**
 * Land a generated artifact's bytes, doing nothing when they already match.
 *
 * Attribution runs AFTER a successful write on both paths, never before: a
 * contributor recorded for a write that then threw would commit a rebuild that
 * never happened.
 */
export async function writeGeneratedArtifact(
  write: GeneratedArtifactWrite,
  env: GeneratedArtifactEnv,
): Promise<GeneratedWriteOutcome> {
  const { docName, absPath, markdown, currentMarkdown } = write;

  // Conflict ownership is independent of residency. An unopened document has
  // no lifecycle Y.Map to consult, but its ConflictStore entry is still the
  // authoritative signal that only the resolver may replace its disk bytes.
  if (env.isConflict(docName)) return 'blocked-conflict';

  const document = env.getDocument(docName);
  if (document) {
    // The conflict lifecycle owns both the banner and resolution. The resident
    // source may still hold clean pre-conflict bytes while disk holds markers;
    // treating that split as an ordinary equality or write would bypass the
    // user's explicit conflict decision.
    if (document.getMap('lifecycle').get('status') === 'conflict') {
      return 'blocked-conflict';
    }
    // A resident Y.Doc is authoritative over its last disk snapshot. Comparing
    // disk first can discard a newer live edit merely because the older file
    // already happens to equal the generated bytes.
    if (document.getText('source').toString() === markdown) return 'unchanged';
    // `replaceRawBody` is imported, not injected: paired writes must route
    // through a sanctioned bridge primitive, and that is enforced by a static
    // scan which cannot follow an injected function. Making this a collaborator
    // would buy a slightly easier unit test and silently disable a STOP rule.
    document.transact(() => {
      replaceRawBody(document, markdown);
    }, env.origin);
    await env.attribute(docName, env.writer);
    return 'document';
  }

  if (currentMarkdown === markdown) return 'unchanged';

  await env.writeDisk(absPath, markdown);
  env.registerWrite(absPath, markdown);
  env.noteFileIndex({
    kind: currentMarkdown === null ? 'create' : 'update',
    absPath,
    docName,
    markdown,
  });
  env.signalFiles();
  await env.attribute(docName, env.writer);
  return 'disk';
}

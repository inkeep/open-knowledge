import type * as Y from 'yjs';
import { replaceRawBody } from '../bridge-intake.ts';
import type { PairedWriteOrigin } from '../server-observers.ts';
import type { WriterIdentity } from '../shadow-repo.ts';

export type GeneratedWriteOutcome = 'unchanged' | 'document' | 'disk' | 'blocked-conflict';

export interface GeneratedArtifactEnv {
  origin: PairedWriteOrigin;
  writer: WriterIdentity;
  isConflict(docName: string): boolean;
  getDocument(docName: string): Y.Doc | undefined;
  writeDisk(absPath: string, markdown: string): void | Promise<void>;
  registerWrite(absPath: string, markdown: string): void;
  noteFileIndex(event: {
    kind: 'create' | 'update';
    absPath: string;
    docName: string;
    markdown: string;
  }): void;
  signalFiles(): void;
  attribute(docName: string, writer: WriterIdentity): Promise<void>;
}

export interface GeneratedArtifactWrite {
  docName: string;
  absPath: string;
  markdown: string;
  currentMarkdown: string | null;
}

export async function writeGeneratedArtifact(
  write: GeneratedArtifactWrite,
  env: GeneratedArtifactEnv,
): Promise<GeneratedWriteOutcome> {
  const { docName, absPath, markdown, currentMarkdown } = write;

  if (env.isConflict(docName)) return 'blocked-conflict';

  const document = env.getDocument(docName);
  if (document) {
    if (document.getMap('lifecycle').get('status') === 'conflict') {
      return 'blocked-conflict';
    }
    if (document.getText('source').toString() === markdown) return 'unchanged';
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

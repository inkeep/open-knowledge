import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import {
  fnv1aDigest,
  MANAGED_ARTIFACT_PREFIX_EXTSKILL,
  MANAGED_ARTIFACT_PREFIX_SKILL,
  MANAGED_ARTIFACT_PREFIX_TEMPLATE,
} from '@inkeep/open-knowledge-core';
import { atomicWriteFile, okUserHomeDir } from '@inkeep/open-knowledge-core/server';
import { displayPathFor } from './display-path.ts';
import { tracedAtomicFs, tracedMkdir, tracedUnlinkSync } from './fs-traced.ts';
import { getLogger } from './logger.ts';
import {
  incrementDisplacedVersionBackupFailures,
  incrementDisplacedVersionBackups,
} from './metrics.ts';

const log = getLogger('edit-backups');

const DISCARDED_EDIT_STASH_MAX = 5;
const DISCARDED_EDIT_READABLE_MAX = 100;
const DISCARDED_EDIT_DIGEST_LEN = 12;
const UNAMBIGUOUS_STASH_SEGMENT_RE = /^(?!.*__)[A-Za-z0-9.-](?:[A-Za-z0-9._-]*[A-Za-z0-9.-])?$/;

export interface BackupCopy {
  readonly abs: string;
  readonly display: string;
}

function discardedEditStashKey(documentName: string): string {
  const legacy = documentName.replace(/[^A-Za-z0-9._-]+/g, '__');
  const prefix = [
    MANAGED_ARTIFACT_PREFIX_SKILL,
    MANAGED_ARTIFACT_PREFIX_TEMPLATE,
    MANAGED_ARTIFACT_PREFIX_EXTSKILL,
  ].find((p) => documentName.startsWith(p));
  const rest = prefix === undefined ? documentName : documentName.slice(prefix.length);
  if (rest.split('/').every((segment) => UNAMBIGUOUS_STASH_SEGMENT_RE.test(segment))) {
    return legacy;
  }
  const canonical = documentName.normalize('NFC');
  const digest = createHash('sha256')
    .update(canonical)
    .digest('hex')
    .slice(0, DISCARDED_EDIT_DIGEST_LEN);
  const readable = canonical
    .replace(/[^A-Za-z0-9._-]+/g, '__')
    .replace(/^\.+/, '_')
    .slice(0, DISCARDED_EDIT_READABLE_MAX);
  return `${readable}-${digest}`;
}

function backupFolder(home: string, project: string | null, documentName: string): string {
  const discarded = resolve(okUserHomeDir(home), 'edit-backups', 'discarded');
  const key = discardedEditStashKey(documentName);
  return project === null
    ? resolve(discarded, key)
    : resolve(discarded, 'projects', fnv1aDigest(project), key);
}

export async function backUpDisplacedVersion(
  home: string,
  project: string | null,
  documentName: string,
  content: string,
  fileName: string,
): Promise<BackupCopy | null> {
  try {
    const dir = backupFolder(home, project, documentName);
    await tracedMkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const abs = resolve(dir, `${stamp}${extname(fileName)}`);
    await atomicWriteFile(abs, content, { fs: tracedAtomicFs });
    const entries = readdirSync(dir).sort();
    for (const old of entries.slice(0, Math.max(0, entries.length - DISCARDED_EDIT_STASH_MAX))) {
      try {
        tracedUnlinkSync(resolve(dir, old));
      } catch {}
    }
    incrementDisplacedVersionBackups();
    const copy = { abs, display: displayPathFor(abs, null, home) };
    log.info(
      { documentName, backup: copy.display },
      'a displaced version was kept in the backup folder',
    );
    return copy;
  } catch (err) {
    incrementDisplacedVersionBackupFailures();
    log.warn({ documentName, err }, 'a displaced version could not be kept in the backup folder');
    return null;
  }
}

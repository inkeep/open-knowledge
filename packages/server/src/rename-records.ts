import { randomUUID } from 'node:crypto';
import { formatRenameSubject } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { recordContributor } from './contributor-tracker.ts';
import { stripDocExtension } from './doc-extensions.ts';
import {
  appendRenameLogEntry,
  getOrLoadRenameLogIndex,
  type RenameLogEntry,
} from './rename-log.ts';
import type { ShadowHandle } from './shadow-repo.ts';

type ContributorActor = Parameters<typeof recordContributor>[5];

export interface RenameRecordWriter {
  readonly writerId: string;
  readonly displayName: string;
  readonly colorSeed?: string;
  readonly actor?: ContributorActor;
}

export interface FollowedMove {
  readonly from: string;
  readonly to: string;
  readonly toFile?: string;
}

export interface RenameNoticeSink {
  rename(oldDocName: string, newDocName: string, branch: string, newFile?: string): void;
}

export function followRenameRecords(input: {
  readonly moves: readonly FollowedMove[];
  readonly kind: RenameLogEntry['kind'];
  readonly branch: string;
  readonly writer: RenameRecordWriter;
  readonly shadow: ShadowHandle | null | undefined;
  readonly notices: RenameNoticeSink | undefined;
  readonly anchors?: readonly string[];
}): number {
  for (const { from, to, toFile } of input.moves) {
    if (from !== to) input.notices?.rename(from, to, input.branch, toFile);
  }
  const shadow = input.shadow;
  if (!shadow) return 0;
  const logged = input.moves.filter(
    ({ from, to }) => stripDocExtension(from) !== stripDocExtension(to),
  );
  if (logged.length === 0) return 0;
  const groupId = randomUUID();
  const at = new Date().toISOString();
  const index = getOrLoadRenameLogIndex(shadow.gitDir);
  for (const { from, to } of logged) {
    appendRenameLogEntry(
      shadow.gitDir,
      {
        v: 1,
        from,
        to,
        at,
        commitSha: '',
        branch: input.branch,
        groupId,
        kind: input.kind,
        actor: { writerId: input.writer.writerId, displayName: input.writer.displayName },
        ...(input.anchors && input.anchors.length > 0 ? { anchors: [...input.anchors] } : {}),
      },
      index,
      shadow,
    );
    recordContributor(
      to,
      input.writer.writerId,
      input.writer.displayName,
      input.writer.colorSeed,
      formatRenameSubject(from, to),
      input.writer.actor,
      undefined,
      [{ from, to }],
    );
  }
  return logged.length;
}

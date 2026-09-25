import type { AttachmentPart } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { useRef, useState } from 'react';
import {
  type AttachmentRefusal,
  attachmentBudgetKb,
  describeAttachmentRefusals,
  describeImageError,
  embeddedAttachmentBytes,
  fileToAttachment,
  isAttachmentRefusal,
  MAX_TOTAL_ATTACHMENT_BYTES,
  totalEmbeddedAttachmentBytes,
} from '@/lib/acp/image-attachment';

export interface UseComposerAttachmentsOptions {
  readonly absPathOf?: (file: File) => string | null;
  readonly workspaceContentDir?: string;
  readonly pathSeparator?: '/' | '\\';
  readonly onError: (message: string) => void;
}

interface ComposerPendingUpload {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
}

export interface ComposerAttachments {
  readonly pendingAttachments: readonly AttachmentPart[];
  readonly pendingUploads: readonly ComposerPendingUpload[];
  readonly ingestFiles: (files: readonly File[]) => Promise<void>;
  readonly removeAt: (index: number) => void;
  readonly clear: () => void;
}

export function useComposerAttachments(
  options: UseComposerAttachmentsOptions,
): ComposerAttachments {
  const { t } = useLingui();
  const [pendingAttachments, setPendingAttachments] = useState<readonly AttachmentPart[]>([]);
  const [pendingUploads, setPendingUploads] = useState<readonly ComposerPendingUpload[]>([]);
  const attachmentsRef = useRef<readonly AttachmentPart[]>(pendingAttachments);
  const generationRef = useRef(0);

  const commit = (next: readonly AttachmentPart[], generation: number): void => {
    if (generation !== generationRef.current) return;
    attachmentsRef.current = next;
    setPendingAttachments(next);
  };

  const ingestFiles = async (files: readonly File[]): Promise<void> => {
    const generation = generationRef.current;
    const report = (message: string): void => {
      if (generation === generationRef.current) options.onError(message);
    };
    const placeholders = files.map((file) => ({
      id: `${file.name}:${file.size}:${file.lastModified ?? 0}:${Math.random().toString(36).slice(2, 8)}`,
      name: file.name || 'attachment',
      mimeType: file.type || '',
    }));
    setPendingUploads((previous) => [...previous, ...placeholders]);
    const refusals: AttachmentRefusal[] = [];
    let tooLargeTotalCount = 0;
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const placeholderId = placeholders[i]?.id;
      if (file === undefined || placeholderId === undefined) continue;
      try {
        const outcome = await fileToAttachment(file, {
          absPathOf: options.absPathOf,
          workspaceContentDir: options.workspaceContentDir,
          pathSeparator: options.pathSeparator,
        });
        setPendingUploads((previous) => previous.filter((p) => p.id !== placeholderId));
        if (!outcome.ok) {
          if (isAttachmentRefusal(outcome.error)) refusals.push(outcome.error);
          else report(describeImageError(outcome.error));
          continue;
        }
        const current = attachmentsRef.current;
        if (
          totalEmbeddedAttachmentBytes(current) + embeddedAttachmentBytes(outcome.part) >
          MAX_TOTAL_ATTACHMENT_BYTES
        ) {
          tooLargeTotalCount += 1;
          continue;
        }
        commit([...current, outcome.part], generation);
      } catch (err) {
        setPendingUploads((previous) => previous.filter((p) => p.id !== placeholderId));
        const fileName = file.name || 'attachment';
        console.error('[useComposerAttachments] failed to read attachment', fileName, err);
        report(t`Couldn't read ${fileName}.`);
      }
    }
    for (const message of describeAttachmentRefusals(refusals)) report(message);
    if (tooLargeTotalCount > 0) {
      const budgetKb = attachmentBudgetKb();
      report(
        t`${plural(tooLargeTotalCount, {
          one: `Skipped # file — attachments can't total more than ${budgetKb} KB per message.`,
          other: `Skipped # files — attachments can't total more than ${budgetKb} KB per message.`,
        })}`,
      );
    }
  };

  return {
    pendingAttachments,
    pendingUploads,
    ingestFiles,
    removeAt: (index: number) => {
      commit(
        attachmentsRef.current.filter((_, i) => i !== index),
        generationRef.current,
      );
    },
    clear: () => {
      generationRef.current += 1;
      commit([], generationRef.current);
      setPendingUploads([]);
    },
  };
}

import {
  AttachmentFolderUploadIssueSchema,
  type ProblemDetails,
} from '@inkeep/open-knowledge-core/schemas/api';
import { t } from '@lingui/core/macro';
import { singleFileUploadMessage } from './upload-admission.ts';

export type UploadFailureKind = 'file-unreadable' | 'network' | 'single-file-mode';

const PROBE_TIMEOUT_MS = 1000;

export interface FileReadProbe {
  readable: boolean;
  bytesRead: number;
  error?: string;
  timedOut?: boolean;
}

export class UploadFailedError extends Error {
  readonly kind: UploadFailureKind;

  constructor(message: string, kind: UploadFailureKind) {
    super(message);
    this.name = 'UploadFailedError';
    this.kind = kind;
  }
}

export class UploadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadRejectedError';
  }
}

export async function probeFileReadable(
  file: Blob,
  sizeAtDrop: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<FileReadProbe> {
  if (sizeAtDrop <= 0) return { readable: true, bytesRead: 0 };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<FileReadProbe>((resolve) => {
    timer = setTimeout(() => resolve({ readable: false, bytesRead: 0, timedOut: true }), timeoutMs);
  });
  const read = (async (): Promise<FileReadProbe> => {
    try {
      const head = await file.slice(0, 1).arrayBuffer();
      return { readable: head.byteLength === 1, bytesRead: head.byteLength };
    } catch (error) {
      return {
        readable: false,
        bytesRead: 0,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
  })();

  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function leftToRight(text: string): string {
  return `\u2066${text}\u2069`;
}

export function attachmentFolderRefusalMessage(problem: ProblemDetails): string | null {
  const parsed = AttachmentFolderUploadIssueSchema.safeParse(problem.attachmentFolderIssue);
  if (!parsed.success) return null;
  const issue = parsed.data;
  switch (issue.kind) {
    case 'unknown-variable': {
      const variables = leftToRight(issue.variables.join(', '));
      return t`Couldn't upload the file. The attachment folder uses the unknown variable ${variables}. Fix it under Attachments in Settings.`;
    }
    case 'unclosed-braces': {
      const open = leftToRight('{{');
      const close = leftToRight('}}');
      return t`Couldn't upload the file. The attachment folder has a ${open} or ${close} without its pair. Fix it under Attachments in Settings.`;
    }
    case 'repeated-variable': {
      const filenameVariable = leftToRight('{{filename}}');
      return t`Couldn't upload the file. The attachment folder uses ${filenameVariable} more than once in one folder name. Fix it under Attachments in Settings.`;
    }
    case 'invalid-config': {
      const settingKey = leftToRight('content.attachmentFolderPath');
      const configFile = leftToRight('.ok/config.yml');
      return t`Couldn't upload the file. The ${settingKey} value in ${configFile} can't be used. Fix it in that file.`;
    }
  }
}

export function classifyUploadFailure(probe: FileReadProbe): UploadFailureKind {
  return probe.readable ? 'network' : 'file-unreadable';
}

export function uploadFailureMessage(kind: UploadFailureKind, fileName: string): string {
  if (kind === 'single-file-mode') return singleFileUploadMessage();
  return kind === 'file-unreadable'
    ? t`Couldn't read ${fileName}. It may have been moved, deleted, or not finished downloading. Try adding it again.`
    : t`Couldn't reach the Open Knowledge server to upload ${fileName}.`;
}

export interface UploadFailureReport {
  kind: UploadFailureKind;
  message: string;
  log: Record<string, unknown>;
}

export async function reportUploadFailure(input: {
  file: File;
  sizeAtDrop: number;
  error: unknown;
}): Promise<UploadFailureReport> {
  const { file, sizeAtDrop, error } = input;
  const probe = await probeFileReadable(file, sizeAtDrop);
  const kind = classifyUploadFailure(probe);
  return {
    kind,
    message: uploadFailureMessage(kind, file.name),
    log: {
      kind,
      name: file.name,
      type: file.type,
      sizeAtDrop,
      sizeAtSend: file.size,
      bytesRead: probe.bytesRead,
      readError: probe.error,
      readTimedOut: probe.timedOut,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    },
  };
}

/**
 * Attachment-placement controls for the Preferences pane. The mode
 * select and folder input are one config leaf
 * (`content.attachmentFolderPath`), so this needs a small custom state
 * machine instead of the single-field schema-form path.
 */

import {
  CONFIG_DOC_NAME_PROJECT,
  type ConfigBinding,
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  humanFormat,
  normalizeAttachmentFolderPath,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigContext } from '@/lib/config-provider';
import { subscribeToConfigValidationRejected } from '@/lib/config-validation-events';
import { cn } from '@/lib/utils';
import { firstIssuePath, SavedIndicator, SectionSkeleton } from './field-controls';
import { pickFirstIssueForPath } from './use-config-form';

type AttachmentPlacementMode =
  | 'same-folder'
  | 'content-root'
  | 'current-folder-subfolder'
  | 'content-root-folder';

const ATTACHMENT_FIELD_NAME = 'content.attachmentFolderPath';
const ATTACHMENT_FALLBACK_FOLDER = 'attachments';

function attachmentModeFromPath(path: string): AttachmentPlacementMode {
  const normalized = normalizeAttachmentFolderPath(path);
  if (normalized === DEFAULT_ATTACHMENT_FOLDER_PATH) return 'same-folder';
  if (normalized === '/') return 'content-root';
  if (normalized.startsWith('./')) return 'current-folder-subfolder';
  return 'content-root-folder';
}

function attachmentFolderTextFromPath(path: string): string {
  const normalized = normalizeAttachmentFolderPath(path);
  if (normalized === DEFAULT_ATTACHMENT_FOLDER_PATH || normalized === '/') {
    return ATTACHMENT_FALLBACK_FOLDER;
  }
  if (normalized.startsWith('./')) {
    return normalized.slice(2) || ATTACHMENT_FALLBACK_FOLDER;
  }
  return normalized;
}

function normalizeAttachmentFolderInput(value: string): string {
  return value
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/g, '');
}

function attachmentPathFromMode(mode: AttachmentPlacementMode, folderText: string): string {
  const folder = normalizeAttachmentFolderInput(folderText) || ATTACHMENT_FALLBACK_FOLDER;
  if (mode === 'same-folder') return DEFAULT_ATTACHMENT_FOLDER_PATH;
  if (mode === 'content-root') return '/';
  if (mode === 'current-folder-subfolder') return `./${folder}`;
  return folder;
}

export function AttachmentsSection() {
  const { projectBinding, projectConfig, projectSynced } = useConfigContext();
  if (!projectBinding || !projectSynced || !projectConfig) {
    return <SectionSkeleton />;
  }
  const attachmentFolderPath =
    projectConfig.content.attachmentFolderPath ?? DEFAULT_ATTACHMENT_FOLDER_PATH;
  return (
    <AttachmentsSectionBody
      key={attachmentFolderPath}
      binding={projectBinding}
      value={attachmentFolderPath}
    />
  );
}

function AttachmentsSectionBody({ binding, value }: { binding: ConfigBinding; value: string }) {
  const { t } = useLingui();
  const [mode, setMode] = useState<AttachmentPlacementMode>(() => attachmentModeFromPath(value));
  const [folderText, setFolderText] = useState(() => attachmentFolderTextFromPath(value));
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const [flashed, setFlashed] = useState(false);
  const savedTickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (savedTickTimerRef.current) clearTimeout(savedTickTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const unsubscribe = subscribeToConfigValidationRejected((event) => {
      if (event.docName !== CONFIG_DOC_NAME_PROJECT) return;
      if (firstIssuePath(event.error) !== ATTACHMENT_FIELD_NAME) return;
      const issue = pickFirstIssueForPath(event.error, ATTACHMENT_FIELD_NAME);
      toast.error(humanFormat(event.error), { duration: 8000 });
      setError(issue);
      setFlashed(true);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => {
        setFlashed(false);
        setError(null);
      }, 600);
    });
    return unsubscribe;
  }, []);

  const flashSavedTick = () => {
    setSavedTick(true);
    if (savedTickTimerRef.current) clearTimeout(savedTickTimerRef.current);
    savedTickTimerRef.current = setTimeout(() => setSavedTick(false), 1200);
  };

  const commitPath = (nextPath: string) => {
    const result = binding.patch({ content: { attachmentFolderPath: nextPath } });
    if (result.ok) {
      setError(null);
      flashSavedTick();
      return;
    }
    const detail = pickFirstIssueForPath(result.error, ATTACHMENT_FIELD_NAME);
    setError(detail);
    toast.error(t`Failed to update attachment location — ${detail}`);
  };

  const onModeChange = (next: string) => {
    if (
      next !== 'same-folder' &&
      next !== 'content-root' &&
      next !== 'current-folder-subfolder' &&
      next !== 'content-root-folder'
    ) {
      return;
    }
    const nextMode = next as AttachmentPlacementMode;
    const nextFolderText =
      nextMode === 'current-folder-subfolder' || nextMode === 'content-root-folder'
        ? folderText || ATTACHMENT_FALLBACK_FOLDER
        : folderText;
    setMode(nextMode);
    setFolderText(nextFolderText);
    commitPath(attachmentPathFromMode(nextMode, nextFolderText));
  };

  const commitFolderText = () => {
    const nextPath = attachmentPathFromMode(mode, folderText);
    setFolderText(attachmentFolderTextFromPath(nextPath));
    commitPath(nextPath);
  };

  const showsFolderInput = mode === 'current-folder-subfolder' || mode === 'content-root-folder';
  const labelId = 'settings-attachments-location-label';
  const inputId = 'settings-attachments-folder-input';

  return (
    <section
      aria-labelledby="settings-attachments-title"
      className="space-y-3"
      data-testid="settings-attachments"
    >
      <div className="space-y-1">
        <h3 id="settings-attachments-title" className="text-base font-semibold">
          <Trans>Attachments</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>Set where pasted and dropped files are stored for this project.</Trans>
        </p>
      </div>

      <div
        className={cn('rounded-md border p-3', flashed && 'animate-settings-flash')}
        data-field={ATTACHMENT_FIELD_NAME}
        data-scope="project"
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(16rem,18rem)] sm:items-start">
          <div className="space-y-0.5">
            <div className="text-sm font-medium" id={labelId}>
              <Trans>Default location for new attachments</Trans>
            </div>
            <p className="text-muted-foreground text-1sm">
              <Trans>Where newly added attachments are placed.</Trans>
            </p>
          </div>
          <Select value={mode} onValueChange={onModeChange}>
            <SelectTrigger
              aria-labelledby={labelId}
              data-testid="settings-attachments-mode"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="same-folder">
                <Trans>Same folder as current file</Trans>
              </SelectItem>
              <SelectItem value="content-root">
                <Trans>Content root</Trans>
              </SelectItem>
              <SelectItem value="current-folder-subfolder">
                <Trans>Subfolder under current folder</Trans>
              </SelectItem>
              <SelectItem value="content-root-folder">
                <Trans>Fixed folder in content root</Trans>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {showsFolderInput ? (
          <div className="mt-3 max-w-sm space-y-1">
            <label className="text-sm font-medium" htmlFor={inputId}>
              <Trans>Folder</Trans>
            </label>
            <Input
              id={inputId}
              value={folderText}
              placeholder={t`e.g. assets/uploads`}
              onChange={(event) => setFolderText(event.target.value)}
              onBlur={commitFolderText}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitFolderText();
                }
              }}
              className="h-8 text-sm"
              data-testid="settings-attachments-folder"
            />
          </div>
        ) : null}

        <div className="mt-2 flex min-h-5 items-center gap-2">
          {error ? (
            <p
              className="text-1sm text-destructive"
              data-field-error={ATTACHMENT_FIELD_NAME}
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <SavedIndicator visible={savedTick} />
        </div>
      </div>
    </section>
  );
}

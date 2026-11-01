import type { ConfigBinding } from '@inkeep/open-knowledge-core/config/bind-config-doc';
import { humanFormat } from '@inkeep/open-knowledge-core/config/errors';
import {
  ATTACHMENT_FOLDER_PATH_VARIABLES,
  type AttachmentFolderPathInputIssue,
  type AttachmentFolderPathPart,
  attachmentFolderForDocument,
  attachmentFolderPathInputIssue,
  canonicalAttachmentFolderPath,
  parseAttachmentFolderPath,
} from '@inkeep/open-knowledge-core/config/schema';
import { CONFIG_DOC_NAME_PROJECT } from '@inkeep/open-knowledge-core/constants/cc1';
import { DEFAULT_ATTACHMENT_FOLDER_PATH } from '@inkeep/open-knowledge-core/constants/upload';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Field, FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useConfigContext } from '@/lib/config-provider';
import { subscribeToConfigValidationRejected } from '@/lib/config-validation-events';
import { cn } from '@/lib/utils';
import { firstIssuePath, SavedIndicator, SectionSkeleton } from './field-controls';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { pickFirstIssueForPath } from './use-config-form';

const ATTACHMENT_FIELD_NAME = 'content.attachmentFolderPath';
const EXAMPLE_DOC_PATH = 'notes/meeting.md';
const EXAMPLE_FILE_NAME = 'image.png';

const ATTACHMENTS_DOCS_URL =
  'https://openknowledge.ai/docs/features/assets-and-embeds#attachment-folder';

function exampleDestination(path: string): string {
  const folder = attachmentFolderForDocument(path, EXAMPLE_DOC_PATH);
  return folder === '' ? EXAMPLE_FILE_NAME : `${folder}/${EXAMPLE_FILE_NAME}`;
}

export function AttachmentsSection() {
  const { projectBinding, projectConfig, projectSynced } = useConfigContext();
  if (!projectBinding || !projectSynced || !projectConfig) {
    return <SectionSkeleton />;
  }
  const attachmentFolderPath = canonicalAttachmentFolderPath(
    projectConfig.content.attachmentFolderPath ?? DEFAULT_ATTACHMENT_FOLDER_PATH,
  );
  return <AttachmentsSectionBody binding={projectBinding} value={attachmentFolderPath} />;
}

function AttachmentsSectionBody({ binding, value }: { binding: ConfigBinding; value: string }) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);
  const [commitAttempted, setCommitAttempted] = useState(false);
  if (syncedValue !== value) {
    setSyncedValue(value);
    setDraft(value);
    setCommitAttempted(false);
  }
  const [scrollLeft, setScrollLeft] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
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
      setServerError(issue);
      setFlashed(true);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => {
        setFlashed(false);
        setServerError(null);
      }, 600);
    });
    return unsubscribe;
  }, []);

  const flashSavedTick = () => {
    setSavedTick(true);
    if (savedTickTimerRef.current) clearTimeout(savedTickTimerRef.current);
    savedTickTimerRef.current = setTimeout(() => setSavedTick(false), 1200);
  };

  const edited = draft !== value;
  const draftProblem = attachmentFolderPathInputIssue(draft);
  const hasError = draftProblem !== null || serverError !== null;
  const announceError = commitAttempted || serverError !== null;

  const commitDraft = () => {
    if (!edited) return;
    if (draftProblem) {
      setCommitAttempted(true);
      return;
    }
    const result = binding.patch({ content: { attachmentFolderPath: draft } });
    if (result.ok) {
      setServerError(null);
      flashSavedTick();
      return;
    }
    const detail = pickFirstIssueForPath(result.error, ATTACHMENT_FIELD_NAME);
    setServerError(detail);
    toast.error(t`Failed to update attachment location — ${detail}`);
  };

  const exampleDoc = EXAMPLE_DOC_PATH;
  const exampleFile = exampleDestination(draft);
  const titleId = 'settings-attachments-title';
  const descriptionId = 'settings-attachments-description';
  const exampleId = 'settings-attachments-path-example';
  const errorId = 'settings-attachments-path-error';
  const describedBy = `${descriptionId} ${hasError ? errorId : exampleId}`;

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="settings-attachments"
    >
      <SettingsSectionHeader
        titleId={titleId}
        title={<Trans>Attachments</Trans>}
        scope="project"
        level="block"
        docUrl={ATTACHMENTS_DOCS_URL}
        descriptionId={descriptionId}
      >
        <Trans>Set where pasted and dropped files are stored.</Trans>
      </SettingsSectionHeader>

      <div
        className={cn(flashed && 'animate-settings-flash')}
        data-field={ATTACHMENT_FIELD_NAME}
        data-scope="project"
      >
        <Field data-invalid={hasError} className="gap-2">
          <div className="relative max-w-md">
            <Input
              aria-labelledby={titleId}
              dir="ltr"
              value={draft}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={hasError}
              aria-describedby={describedBy}
              onChange={(event) => {
                setDraft(event.target.value);
                setCommitAttempted(false);
                setServerError(null);
                setScrollLeft(event.target.scrollLeft);
              }}
              onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
              onSelect={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
              onBlur={commitDraft}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                commitDraft();
              }}
              className="font-mono text-sm text-transparent caret-foreground md:text-sm"
              data-testid="settings-attachments-path"
            />
            <AttachmentPathHighlight value={draft} scrollLeft={scrollLeft} />
          </div>
          <div className="flex min-h-5 items-center gap-2">
            {hasError ? (
              <FieldError
                key={announceError ? 'announced' : 'typing'}
                role={announceError ? 'alert' : undefined}
                id={errorId}
                data-field-error={ATTACHMENT_FIELD_NAME}
                data-testid={errorId}
              >
                {draftProblem ? <DraftProblemMessage problem={draftProblem} /> : serverError}
              </FieldError>
            ) : (
              <p
                className="text-1sm text-muted-foreground"
                id={exampleId}
                data-testid="settings-attachments-preview"
              >
                <Trans>
                  Example: a file added to <code dir="ltr">{exampleDoc}</code> is saved as{' '}
                  <code dir="ltr">{exampleFile}</code>
                </Trans>
              </p>
            )}
            <SavedIndicator visible={savedTick} />
          </div>
        </Field>
      </div>
    </section>
  );
}

function DraftProblemMessage({ problem }: { problem: AttachmentFolderPathInputIssue }) {
  const filenameVariable = <bdi dir="ltr">{'{{filename}}'}</bdi>;
  switch (problem.kind) {
    case 'empty':
    case 'missing-prefix':
    case 'outside-project': {
      const documentPrefix = <bdi dir="ltr">./</bdi>;
      const rootPrefix = <bdi dir="ltr">/</bdi>;
      const parentFolder = <bdi dir="ltr">..</bdi>;
      return (
        <Trans>
          Folder path must start with {documentPrefix} or {rootPrefix} and cannot contain{' '}
          {parentFolder}
        </Trans>
      );
    }
    case 'reserved-character': {
      const reserved = <bdi dir="ltr">{'< > : " \\ | ? *'}</bdi>;
      return <Trans>Folder names cannot contain {reserved}.</Trans>;
    }
    case 'surrounding-space':
      return <Trans>Remove the spaces at the start or end of the path.</Trans>;
    case 'empty-folder-name':
      return <Trans>Use one slash between folder names.</Trans>;
    case 'trailing-slash':
      return <Trans>Remove the slash at the end of the path.</Trans>;
    case 'single-brace':
      return <Trans>A variable needs two braces on each side, such as {filenameVariable}.</Trans>;
    case 'unknown-variable': {
      const unknownList = <bdi dir="ltr">{problem.variables.join(', ')}</bdi>;
      const supportedVariables = (
        <bdi dir="ltr">
          {ATTACHMENT_FOLDER_PATH_VARIABLES.map((name) => `{{${name}}}`).join(', ')}
        </bdi>
      );
      return (
        <Trans>
          Unknown variable {unknownList}. Available variables: {supportedVariables}.
        </Trans>
      );
    }
    case 'unclosed-braces': {
      const open = <bdi dir="ltr">{'{{'}</bdi>;
      const close = <bdi dir="ltr">{'}}'}</bdi>;
      return (
        <Trans>
          Each {open} needs a matching {close}.
        </Trans>
      );
    }
    case 'repeated-variable':
      return <Trans>Use {filenameVariable} at most once in each folder name.</Trans>;
    default:
      return assertNeverDraftProblem(problem);
  }
}

function assertNeverDraftProblem(problem: never): never {
  throw new Error(`unhandled attachment path problem: ${JSON.stringify(problem)}`);
}

function AttachmentPathHighlight({ value, scrollLeft }: { value: string; scrollLeft: number }) {
  return (
    <div
      aria-hidden="true"
      dir="ltr"
      data-testid="settings-attachments-path-highlight"
      className="pointer-events-none absolute inset-0 flex items-center overflow-hidden rounded-lg border border-transparent px-2.5 font-mono text-sm whitespace-pre forced-colors:hidden"
    >
      <span style={{ transform: `translateX(${-scrollLeft}px)` }}>
        {parseAttachmentFolderPath(value).map((part) => (
          <AttachmentPathPart key={part.start} part={part} />
        ))}
      </span>
    </div>
  );
}

function AttachmentPathPart({ part }: { part: AttachmentFolderPathPart }) {
  switch (part.kind) {
    case 'text':
      return <span>{part.text}</span>;
    case 'variable':
      return (
        <span
          data-token="known"
          className="rounded-sm bg-primary/15 text-foreground ring-1 ring-primary/40"
        >
          {part.text}
        </span>
      );
    case 'unknown-variable':
      return (
        <span
          data-token="unknown"
          className="text-destructive underline decoration-destructive decoration-wavy underline-offset-4"
        >
          {part.text}
        </span>
      );
    default:
      return assertNeverPathPart(part);
  }
}

function assertNeverPathPart(part: never): never {
  throw new Error(`unhandled attachment path part: ${JSON.stringify(part)}`);
}

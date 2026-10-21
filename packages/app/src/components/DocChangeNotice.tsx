import type { DocNoticeWire } from '@inkeep/open-knowledge-core/schemas/api';
import { Trans, useLingui } from '@lingui/react/macro';
import { History, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { requestDocPanelTab } from '@/components/doc-panel-events';
import { SkillModeBanner } from '@/components/SkillModeBanner';
import { Button } from '@/components/ui/button';
import { useDocNotices } from '@/hooks/use-doc-notices';
import { saveHeldMessage } from '@/lib/save-held-message';
import { useSingleFileMode } from '@/lib/single-file-mode';

const announcedNoticeIds = new Set<string>();

const EDITOR_FOCUS_TARGETS = ['[contenteditable="true"]', '.cm-content'] as const;

type NoticeFileLabel = 'name' | 'path';

function noticeFileText(notice: DocNoticeWire, fileLabel: NoticeFileLabel): string {
  return fileLabel === 'path' ? notice.file : (notice.file.split('/').pop() ?? notice.file);
}

function NoticeMessage({
  notice,
  canOpenTimeline,
  fileLabel,
}: {
  notice: DocNoticeWire;
  canOpenTimeline: boolean;
  fileLabel: NoticeFileLabel;
}) {
  const { t } = useLingui();
  const fileName = (
    <span translate="no" className="font-medium text-foreground">
      {noticeFileText(notice, fileLabel)}
    </span>
  );
  if (notice.kind === 'save-held') {
    return t(saveHeldMessage(notice.cause, noticeFileText(notice, fileLabel)));
  }
  if (notice.kind === 'moved-to-backup') {
    const backupPath = (
      <span translate="no" className="font-medium text-foreground break-all">
        {notice.backup}
      </span>
    );
    if (notice.reason === 'outside-settings-applied') {
      return (
        <Trans>
          Settings in {fileName} changed outside OpenKnowledge and now apply. A copy of the change
          you were making was saved to {backupPath}.
        </Trans>
      );
    }
    if (notice.reason === 'outside-settings-invalid') {
      return (
        <Trans>
          An outside change to {fileName} was not valid settings, so your settings stayed. A copy of
          the outside version was saved to {backupPath}.
        </Trans>
      );
    }
    return (
      <Trans>
        An outside change to {fileName} could not be merged, so this version stayed. The outside
        version was saved to {backupPath}.
      </Trans>
    );
  }
  if (notice.kind === 'both-kept') {
    if (notice.kept.duplicated > 0) {
      return (
        <Trans>
          Both versions were kept in {fileName}. It changed outside OpenKnowledge in the same place
          as here, so the outside version is directly under this one.
        </Trans>
      );
    }
    if (notice.entries.length === 0) {
      return (
        <Trans>
          A deletion in {fileName} was undone because the same text was changed on the other side.
        </Trans>
      );
    }
    return canOpenTimeline ? (
      <Trans>
        A deletion in {fileName} was undone because the same text was changed on the other side. The
        earlier versions are in the timeline.
      </Trans>
    ) : (
      <Trans>
        A deletion in {fileName} was undone because the same text was changed on the other side. The
        earlier versions were saved to the document's history.
      </Trans>
    );
  }
  if (notice.reason === 'outside-settings-applied') {
    return (
      <Trans>
        Settings in {fileName} changed outside OpenKnowledge and now apply. A copy of the change you
        were making was kept in this project's history, which the app cannot show yet.
      </Trans>
    );
  }
  if (notice.reason === 'outside-settings-invalid') {
    return (
      <Trans>
        An outside change to {fileName} was not valid settings, so your settings stayed. A copy of
        the outside version was kept in this project's history, which the app cannot show yet.
      </Trans>
    );
  }
  if (notice.side === 'theirs') {
    return canOpenTimeline ? (
      <Trans>
        An outside change to {fileName} could not be merged, so this version stayed. The outside
        version is in the timeline.
      </Trans>
    ) : (
      <Trans>
        An outside change to {fileName} could not be merged, so this version stayed. The outside
        version was saved to the document's history.
      </Trans>
    );
  }
  return canOpenTimeline ? (
    <Trans>
      Edits to {fileName} kept from the last time this branch was open could not be merged, so the
      file's version stayed. Those edits are in the timeline.
    </Trans>
  ) : (
    <Trans>
      Edits to {fileName} kept from the last time this branch was open could not be merged, so the
      file's version stayed. Those edits were saved to the document's history.
    </Trans>
  );
}

function focusEditorWithin(scope: HTMLElement | null): void {
  if (scope === null) return;
  for (const selector of EDITOR_FOCUS_TARGETS) {
    for (const target of scope.querySelectorAll<HTMLElement>(selector)) {
      target.focus();
      if (document.activeElement === target) return;
    }
  }
  scope.closest<HTMLElement>('[data-editor-region]')?.focus();
}

interface NoticeSectionProps {
  notice: DocNoticeWire;
  canOpenTimeline: boolean;
  fileLabel: NoticeFileLabel;
  onDismissFocus?: () => void;
  messageRef: (node: HTMLSpanElement | null) => void;
  dismiss: (notice: DocNoticeWire) => void;
}

function NoticeSection({
  notice,
  canOpenTimeline,
  fileLabel,
  onDismissFocus,
  messageRef,
  dismiss,
}: NoticeSectionProps) {
  const { t } = useLingui();
  const sectionRef = useRef<HTMLElement>(null);

  function handleDismiss() {
    const hadFocus = sectionRef.current?.contains(document.activeElement) ?? false;
    const scope = sectionRef.current?.parentElement ?? null;
    dismiss(notice);
    if (!hadFocus) return;
    requestAnimationFrame(() => {
      if (onDismissFocus) onDismissFocus();
      else focusEditorWithin(scope);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.stopPropagation();
    handleDismiss();
  }

  return (
    <section
      ref={sectionRef}
      aria-label={t`File change notice`}
      data-slot="doc-change-notice"
      data-testid="doc-change-notice"
      onKeyDown={handleKeyDown}
      className="shrink-0"
    >
      <SkillModeBanner
        icon={<History className="size-4" aria-hidden />}
        clampLines={false}
        actions={
          <>
            {canOpenTimeline && notice.entries.length > 0 ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto px-1"
                onClick={() => requestDocPanelTab('timeline', { focus: 'panel' })}
              >
                {t`Open timeline`}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground"
              aria-label={t`Dismiss notice`}
              onClick={handleDismiss}
            >
              <X className="size-3.5" aria-hidden />
            </Button>
          </>
        }
      >
        <span ref={messageRef}>
          <NoticeMessage notice={notice} canOpenTimeline={canOpenTimeline} fileLabel={fileLabel} />
        </span>
      </SkillModeBanner>
    </section>
  );
}

export function DocChangeNotice({
  docName,
  timelineAvailable,
  fileLabel = 'name',
  onDismissFocus,
}: {
  docName: string;
  timelineAvailable: boolean;
  fileLabel?: NoticeFileLabel;
  onDismissFocus?: () => void;
}) {
  const { notices, dismiss } = useDocNotices(docName);
  const singleFile = useSingleFileMode();
  const messages = useRef(new Map<string, HTMLSpanElement>());
  const [announcement, setAnnouncement] = useState('');
  const canOpenTimeline = timelineAvailable && !singleFile;

  useEffect(() => {
    const fresh = notices.filter((notice) => !announcedNoticeIds.has(notice.id));
    if (fresh.length === 0) return;
    for (const notice of fresh) announcedNoticeIds.add(notice.id);
    setAnnouncement(
      fresh.map((notice) => messages.current.get(notice.id)?.textContent ?? '').join(' '),
    );
  }, [notices]);

  return (
    <>
      <span role="status" className="sr-only">
        {announcement}
      </span>
      {notices.map((notice) => (
        <NoticeSection
          key={notice.id}
          notice={notice}
          canOpenTimeline={canOpenTimeline}
          fileLabel={fileLabel}
          onDismissFocus={onDismissFocus}
          messageRef={(node) => {
            if (node === null) messages.current.delete(notice.id);
            else messages.current.set(notice.id, node);
          }}
          dismiss={dismiss}
        />
      ))}
    </>
  );
}

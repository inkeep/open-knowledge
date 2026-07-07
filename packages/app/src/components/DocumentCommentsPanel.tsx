import {
  type TargetData,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2, MessageSquareText, Send, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AgentSplitButton } from '@/components/handoff/AgentSplitButton';
import { useTerminalLaunch } from '@/components/handoff/TerminalLaunchContext';
import {
  buildComposerHandoffInput,
  useHandoffDispatch,
} from '@/components/handoff/useHandoffDispatch';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  addPendingDocumentComment,
  clearDocumentComments,
  clearPendingDocumentComment,
  type DocumentComment,
  deleteDocumentComment,
  formatCommentsForAgent,
  setActiveDocumentComment,
  updateDocumentCommentBody,
  useDocumentComments,
} from '@/editor/comments/comment-store';
import { useInstalledClis } from '@/hooks/use-installed-clis';
import { resolveDefaultCli } from '@/lib/default-cli-resolver';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { recordOnboardingAskedAi } from '@/lib/onboarding-signals';
import {
  loadStickyAgent,
  parseStickyCliId,
  resolveStickyAgent,
  saveStickyAgent,
  terminalCliId,
} from '@/lib/unified-agent-store';
import { useWorkspace } from '@/lib/use-workspace';
import { cn } from '@/lib/utils';
import { useInstalledAgents } from './handoff/useInstalledAgents';

export function DocumentCommentsPanel({ docName }: { readonly docName: string }) {
  const { t } = useLingui();
  const workspace = useWorkspace();
  const { states } = useInstalledAgents();
  const { dispatch } = useHandoffDispatch();
  const terminalLaunch = useTerminalLaunch();
  const installedClis = useInstalledClis();
  const snapshot = useDocumentComments(docName);
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [stickyId] = useState(() => loadStickyAgent());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setBody('');
    if (snapshot.pending) {
      const id = requestAnimationFrame(() => textareaRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [snapshot.pending]);

  const effectiveId = selectedId ?? stickyId;
  const explicitCli: TerminalCli | null =
    terminalLaunch !== null ? parseStickyCliId(effectiveId) : null;
  const defaultCli: TerminalCli | null =
    terminalLaunch !== null && effectiveId === null ? resolveDefaultCli(null, installedClis) : null;
  const selectedCli = explicitCli ?? defaultCli;
  const resolvedTarget = selectedCli !== null ? null : resolveStickyAgent(states, effectiveId);
  const installedTargets = VISIBLE_TARGETS.filter(
    (target) => states[target.id]?.installed === true,
  );
  const agentProbePending = VISIBLE_TARGETS.some((target) => states[target.id]?.installed == null);
  const canSend =
    !pending && snapshot.comments.length > 0 && (selectedCli !== null || resolvedTarget !== null);

  const handleSelectAgent = (target: TargetData) => {
    setSelectedId(target.id);
    saveStickyAgent(target.id);
  };

  const handleSelectCli = (cli: TerminalCli) => {
    const id = terminalCliId(cli);
    setSelectedId(id);
    saveStickyAgent(id);
  };

  const cliRows =
    terminalLaunch !== null
      ? TERMINAL_CLI_IDS.map((cli) => {
          const { displayName } = TERMINAL_CLIS[cli];
          return {
            cli,
            label: displayName,
            ariaLabel: t`${displayName} CLI`,
            selected: selectedCli === cli,
            onSelect: () => handleSelectCli(cli),
          };
        })
      : undefined;

  function addComment() {
    if (!body.trim()) return;
    addPendingDocumentComment(docName, body);
    setBody('');
  }

  function sendComments() {
    if (!canSend) return;
    const instruction = formatCommentsForAgent(snapshot.comments);
    const input = buildComposerHandoffInput({
      docName,
      workspace,
      instruction,
      mentions: [],
    });
    if (input === null) {
      toast.error(t`Couldn't send comments. Please try again.`);
      return;
    }

    const sentIds = snapshot.comments.map((comment) => comment.id);
    if (selectedCli !== null && terminalLaunch !== null) {
      try {
        terminalLaunch.launchInTerminal(input, selectedCli);
      } catch {
        toast.error(t`Couldn't open the terminal. Please try again.`);
        return;
      }
      recordOnboardingAskedAi();
      clearDocumentComments(docName, sentIds);
      return;
    }

    if (resolvedTarget === null) return;
    setPending(true);
    void dispatch(resolvedTarget.id, input)
      .then((outcome) => {
        if (!outcome.ok) return;
        recordOnboardingAskedAi();
        clearDocumentComments(docName, sentIds);
      })
      .finally(() => setPending(false));
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquareText className="size-4 text-muted-foreground" aria-hidden />
          <span className="truncate font-medium text-sm">
            <Trans>Comments</Trans>
          </span>
          {snapshot.comments.length > 0 ? (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
              {snapshot.comments.length}
            </span>
          ) : null}
        </div>
        <AgentSplitButton
          primary={
            <>
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Send className="size-3.5" aria-hidden />
              )}
              <span>
                <Trans>Send</Trans>
              </span>
            </>
          }
          onPrimary={sendComments}
          primaryDisabled={!canSend}
          installedTargets={installedTargets}
          selectedTargetId={selectedCli === null ? (resolvedTarget?.id ?? null) : null}
          onSelectTarget={handleSelectAgent}
          terminals={cliRows}
          menuEmptyState={
            <div className="px-2 py-1.5 text-muted-foreground text-xs">
              {agentProbePending ? <Trans>Checking agents</Trans> : <Trans>No agents found</Trans>}
            </div>
          }
          triggerAriaLabel={t`Choose comment target`}
          testIds={{
            primary: 'comments-send',
            trigger: 'comments-agent-menu-trigger',
            menu: 'comments-agent-menu',
            option: (id) => `comments-agent-option-${id}`,
            terminal: (cli) => `comments-terminal-option-${cli}`,
          }}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {snapshot.pending ? (
          <div className="border-b p-3">
            <div className="mb-2 rounded-md bg-muted/50 px-2 py-1 text-muted-foreground text-xs">
              <span className="line-clamp-3 font-mono">
                {snapshot.pending.markdown || snapshot.pending.anchorText}
              </span>
            </div>
            <Textarea
              ref={textareaRef}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  addComment();
                }
                if (event.key === 'Escape') {
                  clearPendingDocumentComment(docName);
                  setBody('');
                }
              }}
              rows={4}
              placeholder={t`Add a comment`}
              className="min-h-24 resize-none bg-background text-sm focus:ring-ring/40"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  clearPendingDocumentComment(docName);
                  setBody('');
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button type="button" size="sm" disabled={!body.trim()} onClick={addComment}>
                <Trans>Add comment</Trans>
              </Button>
            </div>
          </div>
        ) : null}

        {snapshot.comments.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground text-sm">
            <Trans>No comments</Trans>
          </div>
        ) : (
          <div className="space-y-2 p-3">
            {snapshot.comments.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                active={snapshot.activeCommentId === comment.id}
                onSelect={() => setActiveDocumentComment(docName, comment.id)}
                onDelete={() => deleteDocumentComment(docName, comment.id)}
                onEdit={(body) => updateDocumentCommentBody(docName, comment.id, body)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CommentCard({
  comment,
  active,
  onSelect,
  onDelete,
  onEdit,
}: {
  readonly comment: DocumentComment;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onDelete: () => void;
  readonly onEdit: (body: string) => void;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!editing) setEditBody(comment.body);
  }, [comment.body, editing]);

  useEffect(() => {
    if (active) cardRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function saveEdit() {
    if (editBody.trim()) onEdit(editBody);
    setEditing(false);
  }

  return (
    <div
      ref={cardRef}
      className={cn(
        'rounded-lg border bg-card/60 p-3 transition-colors',
        active ? 'border-ring bg-ring/10' : 'border-border hover:border-foreground/20',
      )}
    >
      {editing ? (
        <div className="space-y-2">
          <div className="mb-2 line-clamp-3 font-mono text-muted-foreground text-xs">
            {comment.markdown || comment.anchorText}
          </div>
          <Textarea
            value={editBody}
            onChange={(event) => setEditBody(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                saveEdit();
              }
              if (event.key === 'Escape') setEditing(false);
            }}
            aria-label={t`Edit comment`}
            rows={3}
            className="resize-none bg-background text-sm focus:ring-ring/40"
            onClick={(event) => event.stopPropagation()}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(false)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="button" size="xs" disabled={!editBody.trim()} onClick={saveEdit}>
              <Trans>Save</Trans>
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mb-2 h-auto w-full select-text flex-col items-stretch justify-start gap-2 whitespace-normal p-0 text-left font-normal text-foreground hover:bg-transparent"
            onClick={onSelect}
          >
            <span className="line-clamp-3 font-mono text-muted-foreground text-xs">
              {comment.markdown || comment.anchorText}
            </span>
            <span className="whitespace-pre-wrap text-sm leading-relaxed">{comment.body}</span>
          </Button>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              {new Date(comment.createdAt).toLocaleTimeString(undefined, {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={(event) => {
                  event.stopPropagation();
                  setEditing(true);
                }}
              >
                <Trans>Edit</Trans>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t`Delete comment`}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete();
                }}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

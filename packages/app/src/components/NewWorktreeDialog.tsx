// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { stripRemotePrefix } from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, ChevronsUpDown, Cloud, FolderOpen, GitBranch, Plus, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { refreshWorktrees } from '@/lib/worktree-store';

interface NewWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bridge: OkDesktopBridge;
  currentBranch: string | null;
  initialBranchName?: string;
  branches?: readonly string[];
  existingWorktreeBranches?: ReadonlySet<string>;
  remoteBranches?: readonly string[];
  behindByBranch?: ReadonlyMap<string, number>;
}

type LocalBaseChoice = { readonly kind: 'local'; readonly name: string };
type RemoteBaseChoice = { readonly kind: 'remote'; readonly ref: string };
type BaseChoice = LocalBaseChoice | RemoteBaseChoice;
type BaseSelection = BaseChoice | null;

function baseSelectionLabel(sel: BaseSelection): string | null {
  if (sel === null) return null;
  return sel.kind === 'local' ? sel.name : sel.ref;
}

function findRemoteRef(name: string, remoteBranches: readonly string[]): string | null {
  if (name.length === 0) return null;
  const preferred = `origin/${name}`;
  if (remoteBranches.includes(preferred)) return preferred;
  return remoteBranches.find((ref) => stripRemotePrefix(ref) === name) ?? null;
}

function createErrorCopy(reason: string): MessageDescriptor {
  switch (reason) {
    case 'branch-exists':
      return msg`A branch with that name already exists. Open its worktree from the switcher instead.`;
    case 'already-checked-out':
      return msg`That branch is already open in another worktree.`;
    case 'path-exists':
      return msg`A worktree folder for that branch already exists.`;
    case 'invalid-branch':
      return msg`Enter a valid branch name (no spaces, no leading dot, no "..").`;
    case 'no-git':
      return msg`This project isn't a git repository, so worktrees aren't available.`;
    case 'empty-repo':
      return msg`This project has no commits yet, so there's no branch to base a worktree on. Make a first commit, then try again.`;
    case 'helper-not-found':
      return msg`Git needs a helper tool (such as git-lfs) that isn't installed or couldn't be found. Install it, then try again.`;
    default:
      return msg`Couldn't create the worktree. Try a different name.`;
  }
}

interface CreateFailure {
  readonly copy: MessageDescriptor;
  readonly detail?: string;
}

export function NewWorktreeDialog({
  open,
  onOpenChange,
  bridge,
  currentBranch,
  branches = [],
  existingWorktreeBranches,
  remoteBranches = [],
  behindByBranch,
  initialBranchName = '',
}: NewWorktreeDialogProps) {
  const { t } = useLingui();
  const formId = useId();
  const nameInputId = useId();
  const baseTriggerId = useId();
  const baseLabelId = useId();
  const captionId = useId();
  const errorId = useId();
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState<BaseSelection>(
    currentBranch !== null ? { kind: 'local', name: currentBranch } : null,
  );
  const [baseOpen, setBaseOpen] = useState(false);
  const [baseQuery, setBaseQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CreateFailure | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const baseSearchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setBranch(initialBranchName);
    setBase(currentBranch !== null ? { kind: 'local', name: currentBranch } : null);
    setBaseOpen(false);
    setBaseQuery('');
    setBusy(false);
    setError(null);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, currentBranch, initialBranchName]);

  const trimmed = branch.trim();
  const canSubmit = !busy && trimmed.length > 0;
  const isLocalBranch = trimmed.length > 0 && branches.includes(trimmed);
  const remoteCheckoutRef = isLocalBranch ? null : findRemoteRef(trimmed, remoteBranches);
  const isRemoteCheckout = remoteCheckoutRef !== null;
  const isCheckout = isLocalBranch || isRemoteCheckout;
  const isExistingWorktree = isLocalBranch && (existingWorktreeBranches?.has(trimmed) ?? false);
  const suggestions = branches.filter((b) => b.toLowerCase().startsWith(trimmed.toLowerCase()));
  const showSuggestions = !busy && suggestions.length > 0 && !isCheckout;

  const localBaseNames =
    currentBranch !== null && !branches.includes(currentBranch)
      ? [currentBranch, ...branches]
      : branches;
  const localBaseOptions: LocalBaseChoice[] = localBaseNames.map((name) => ({
    kind: 'local',
    name,
  }));
  const remoteBaseOptions: RemoteBaseChoice[] = remoteBranches.map((ref) => ({
    kind: 'remote',
    ref,
  }));
  const currentBaseLabel = baseSelectionLabel(base);
  const trimmedBaseQuery = baseQuery.trim().toLowerCase();
  const filteredLocalBaseOptions =
    trimmedBaseQuery === ''
      ? localBaseOptions
      : localBaseOptions.filter((opt) => opt.name.toLowerCase().includes(trimmedBaseQuery));
  const filteredRemoteBaseOptions =
    trimmedBaseQuery === ''
      ? remoteBaseOptions
      : remoteBaseOptions.filter((opt) => opt.ref.toLowerCase().includes(trimmedBaseQuery));
  const hasNoBaseMatches =
    trimmedBaseQuery !== '' &&
    filteredLocalBaseOptions.length === 0 &&
    filteredRemoteBaseOptions.length === 0;

  async function onSubmit(e: React.SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const request = isRemoteCheckout
        ? { branch: trimmed, createBranch: true, remoteRef: remoteCheckoutRef }
        : isLocalBranch
          ? { branch: trimmed, createBranch: false }
          : {
              branch: trimmed,
              createBranch: true,
              baseBranch: base?.kind === 'local' ? base.name : undefined,
              baseRef: base?.kind === 'remote' ? base.ref : undefined,
            };
      const result = await bridge.worktree.create(request);
      if (!result.ok) {
        setError({ copy: createErrorCopy(result.reason), detail: result.message });
        setBusy(false);
        return;
      }
      refreshWorktrees();
      onOpenChange(false);
      await bridge.project.open({
        path: result.path,
        target: 'new-window',
        entryPoint: 'worktree',
      });
    } catch (err) {
      console.warn('[NewWorktreeDialog] worktree create/open failed:', err);
      toast.error(t`Couldn't open the worktree. Try again.`);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="new-worktree-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>New worktree</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Create a new branch, or check out an existing one, in its own window.</Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-2">
            <Label htmlFor={nameInputId}>
              <Trans>Branch name</Trans>
            </Label>
            <Input
              id={nameInputId}
              ref={inputRef}
              value={branch}
              placeholder={t`my-feature`}
              onChange={(e) => {
                setBranch(e.target.value);
                if (error !== null) setError(null);
              }}
              disabled={busy}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={error !== null}
              aria-describedby={error !== null ? `${captionId} ${errorId}` : captionId}
              data-testid="new-worktree-branch"
            />
            {trimmed.length > 0 ? (
              <p
                id={captionId}
                className="flex items-start gap-1.5 text-1sm text-muted-foreground"
                data-testid={
                  isExistingWorktree
                    ? 'new-worktree-mode-existing-worktree'
                    : isRemoteCheckout
                      ? 'new-worktree-mode-remote-checkout'
                      : isLocalBranch
                        ? 'new-worktree-mode-checkout'
                        : 'new-worktree-mode-create'
                }
              >
                {isExistingWorktree ? (
                  <FolderOpen
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                  />
                ) : isRemoteCheckout ? (
                  <Cloud
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 text-violet-600 dark:text-violet-400"
                  />
                ) : isLocalBranch ? (
                  <Check
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 text-blue-600 dark:text-blue-400"
                  />
                ) : (
                  <Plus
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 text-green-600 dark:text-green-400"
                  />
                )}
                {}
                <span className="min-w-0 flex-1">
                  {isExistingWorktree ? (
                    <Trans>
                      Branch <code className="font-mono break-words">{trimmed}</code> already has a
                      worktree — it'll open in its own window.
                    </Trans>
                  ) : isRemoteCheckout ? (
                    <Trans>
                      Remote branch{' '}
                      <code className="font-mono break-words">{remoteCheckoutRef}</code> will be
                      checked out as a new local tracking branch{' '}
                      <code className="font-mono break-words">{trimmed}</code>, in its own window
                      under <code className="font-mono">.ok/worktrees/</code>.
                    </Trans>
                  ) : isLocalBranch ? (
                    <Trans>
                      Existing branch <code className="font-mono break-words">{trimmed}</code> will
                      be checked out into its own window, under{' '}
                      <code className="font-mono">.ok/worktrees/</code>.
                    </Trans>
                  ) : currentBaseLabel !== null ? (
                    <Trans>
                      New branch <code className="font-mono break-words">{trimmed}</code> will be
                      created from <code className="font-mono break-words">{currentBaseLabel}</code>
                      , in its own worktree under <code className="font-mono">.ok/worktrees/</code>.
                    </Trans>
                  ) : (
                    <Trans>
                      New branch <code className="font-mono break-words">{trimmed}</code> will be
                      created from the current commit, in its own worktree under{' '}
                      <code className="font-mono">.ok/worktrees/</code>.
                    </Trans>
                  )}
                </span>
              </p>
            ) : null}
            {showSuggestions ? (
              <div
                className="max-h-40 overflow-y-auto rounded-md border bg-popover p-1 shadow-xs"
                data-testid="new-worktree-branch-list"
              >
                {suggestions.map((b) => (
                  <Button
                    key={b}
                    type="button"
                    variant="ghost"
                    size="sm"
                    tabIndex={-1}
                    onClick={() => {
                      setBranch(b);
                      if (error !== null) setError(null);
                      inputRef.current?.focus();
                    }}
                    data-testid={`new-worktree-branch-option-${b}`}
                    className="h-8 w-full justify-start gap-2 font-normal"
                  >
                    <GitBranch
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate text-left">{b}</span>
                  </Button>
                ))}
              </div>
            ) : null}
            {}
            {!isCheckout ? (
              <div className="mt-1 flex flex-col gap-2">
                <Label id={baseLabelId} htmlFor={baseTriggerId}>
                  <Trans>Base branch</Trans>
                </Label>
                <Popover
                  open={baseOpen}
                  onOpenChange={(next) => {
                    setBaseOpen(next);
                    if (!next) setBaseQuery('');
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      id={baseTriggerId}
                      type="button"
                      variant="outline"
                      role="combobox"
                      aria-expanded={baseOpen}
                      aria-haspopup="listbox"
                      aria-labelledby={`${baseLabelId} ${baseTriggerId}`}
                      aria-label={t`Base branch`}
                      disabled={busy}
                      data-testid="new-worktree-base-trigger"
                      className="w-full justify-between font-normal"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {base?.kind === 'remote' ? (
                          <Cloud
                            aria-hidden="true"
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                        ) : (
                          <GitBranch
                            aria-hidden="true"
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                        )}
                        <span className="min-w-0 truncate text-left">
                          {currentBaseLabel !== null ? (
                            currentBaseLabel
                          ) : (
                            <Trans>Current commit</Trans>
                          )}
                        </span>
                      </span>
                      <ChevronsUpDown
                        aria-hidden="true"
                        className="ml-2 size-4 shrink-0 opacity-50"
                      />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className="w-[var(--radix-popover-trigger-width)] p-1"
                    /*
                     * UPSTREAM(radix-ui/primitives#1159): the Dialog's
                     * react-remove-scroll preventDefaults native scroll on
                     * portaled descendants, and this popover renders to
                     * document.body. stopPropagation keeps the event away from
                     * those document listeners so the list scrolls.
                     */
                    onWheel={(e) => {
                      e.stopPropagation();
                    }}
                    onTouchMove={(e) => {
                      e.stopPropagation();
                    }}
                    onOpenAutoFocus={(e) => {
                      e.preventDefault();
                      baseSearchRef.current?.focus();
                    }}
                  >
                    <InputGroup className="mb-1 h-8">
                      <InputGroupInput
                        ref={baseSearchRef}
                        aria-label={t`Search branches`}
                        placeholder={t`Search branches...`}
                        value={baseQuery}
                        onChange={(e) => setBaseQuery(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                        data-testid="new-worktree-base-search"
                      />
                      <InputGroupAddon>
                        <Search aria-hidden="true" />
                      </InputGroupAddon>
                    </InputGroup>
                    <div
                      role="listbox"
                      aria-label={t`Base branch`}
                      className="max-h-56 overflow-y-auto"
                      data-testid="new-worktree-base-list"
                    >
                      {hasNoBaseMatches ? (
                        <p className="px-2 py-1.5 text-1sm text-muted-foreground">
                          <Trans>No matching branches.</Trans>
                        </p>
                      ) : null}
                      {filteredLocalBaseOptions.map((opt) => {
                        const name = opt.name;
                        const behind = behindByBranch?.get(name);
                        const selected = base?.kind === 'local' && base.name === name;
                        return (
                          <Button
                            key={`local:${name}`}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setBase(opt);
                              setBaseOpen(false);
                              setBaseQuery('');
                            }}
                            data-testid={`new-worktree-base-option-${name}`}
                            className="h-8 w-full justify-start gap-2 font-normal"
                          >
                            <GitBranch
                              aria-hidden="true"
                              className="size-3.5 shrink-0 text-muted-foreground"
                            />
                            <span className="min-w-0 flex-1 truncate text-left">{name}</span>
                            {}
                            {behind !== undefined && behind > 0 ? (
                              <span
                                className="shrink-0 text-xs text-amber-600 dark:text-amber-400"
                                data-testid={`new-worktree-base-behind-${name}`}
                              >
                                <Trans>{behind} behind origin</Trans>
                              </span>
                            ) : null}
                          </Button>
                        );
                      })}
                      {filteredRemoteBaseOptions.map((opt) => {
                        const ref = opt.ref;
                        const selected = base?.kind === 'remote' && base.ref === ref;
                        return (
                          <Button
                            key={`remote:${ref}`}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setBase(opt);
                              setBaseOpen(false);
                              setBaseQuery('');
                            }}
                            data-testid={`new-worktree-base-option-${ref}`}
                            className="h-8 w-full justify-start gap-2 font-normal"
                          >
                            <Cloud
                              aria-hidden="true"
                              className="size-3.5 shrink-0 text-muted-foreground"
                            />
                            <span className="min-w-0 flex-1 truncate text-left">{ref}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              <Trans>remote</Trans>
                            </span>
                          </Button>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            ) : null}
            {error !== null ? (
              <div id={errorId} role="alert">
                <p className="text-1sm text-destructive" data-testid="new-worktree-error">
                  {t(error.copy)}
                </p>
                {error.detail !== undefined && error.detail.length > 0 ? (
                  <p
                    className="mt-1 break-words font-mono text-xs text-muted-foreground"
                    data-testid="new-worktree-error-detail"
                  >
                    {error.detail}
                  </p>
                ) : null}
              </div>
            ) : null}
          </form>
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            data-testid="new-worktree-cancel"
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={!canSubmit}
            data-testid="new-worktree-create"
          >
            {busy ? (
              <Trans>Working</Trans>
            ) : isExistingWorktree ? (
              <Trans>Open worktree</Trans>
            ) : isRemoteCheckout ? (
              <Trans>Check out remote branch</Trans>
            ) : isLocalBranch ? (
              <Trans>Check out worktree</Trans>
            ) : (
              <Trans>Create worktree</Trans>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

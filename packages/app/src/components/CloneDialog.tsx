import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { GlobeIcon, LockIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getLastKnownSignedIn, setLastKnownSignedIn } from '@/lib/auth-state-cache';
import {
  type AuthQueryTransport,
  httpAuthQueryTransport,
} from '@/lib/transports/auth-query-transport';
import { type CloneTransport, httpCloneTransport } from '@/lib/transports/clone-transport';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover';
import { Skeleton } from './ui/skeleton';

interface RepoEntry {
  full_name: string;
  clone_url: string;
  private: boolean;
}

type ClonePhase = 'receiving' | 'resolving' | 'checking' | 'init' | 'done' | string;

function phaseLabel(phase: ClonePhase): MessageDescriptor {
  switch (phase) {
    case 'receiving':
      return msg`Receiving objects`;
    case 'resolving':
      return msg`Resolving deltas`;
    case 'checking':
      return msg`Checking out files`;
    case 'init':
      return msg`Initializing project`;
    case 'done':
      return msg`Complete`;
    default:
      return msg`Cloning`;
  }
}

function extractRepoName(input: string): string {
  const trimmed = input.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return trimmed.split('/')[1];
  try {
    const url = new URL(trimmed.replace(/^git@([^:]+):/, 'https://$1/'));
    return (
      url.pathname
        .replace(/\.git$/, '')
        .split('/')
        .pop() ?? 'repo'
    );
  } catch {
    return (
      trimmed
        .split('/')
        .pop()
        ?.replace(/\.git$/, '') ?? 'repo'
    );
  }
}

interface CloneDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignIn?: () => void;
  onCloneComplete?: (info: { port?: number; dir: string }) => void;
  transport?: CloneTransport;
  authQueryTransport?: AuthQueryTransport;
  pickParentFolder?: () => Promise<string | null>;
  initialUrl?: string;
}

export function CloneDialog({
  open,
  onOpenChange,
  onSignIn,
  onCloneComplete,
  transport,
  authQueryTransport,
  pickParentFolder,
  initialUrl,
}: CloneDialogProps) {
  const { t } = useLingui();
  const resolvedTransport = transport ?? httpCloneTransport();
  const resolvedAuthQuery = authQueryTransport ?? httpAuthQueryTransport();
  const usePicker = pickParentFolder !== undefined;
  const [urlInput, setUrlInput] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [repos, setRepos] = useState<RepoEntry[] | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState<boolean | null>(getLastKnownSignedIn());
  const [cloning, setCloning] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const cancelRef = useRef<(() => void) | null>(null);
  const toastIdRef = useRef<string | number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolvedAuthQuery is stable per render
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void resolvedAuthQuery
      .status()
      .then((data) => {
        setLastKnownSignedIn(data.authenticated);
        if (!cancelled) setIsSignedIn(data.authenticated);
      })
      .catch(() => {
        if (!cancelled) setIsSignedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolvedAuthQuery is stable per render
  useEffect(() => {
    if (!isSignedIn || !open) return;
    let cancelled = false;
    setLoadingRepos(true);
    void resolvedAuthQuery
      .repos()
      .then((result) => {
        if (cancelled) return;
        setRepos(result.ok ? result.repos : []);
        setLoadingRepos(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRepos([]);
        setLoadingRepos(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, open]);

  useEffect(() => {
    if (!open) return;
    if (!initialUrl) return;
    setUrlInput(initialUrl);
    if (usePicker) return;
    const name = extractRepoName(initialUrl);
    if (name) setLocalPath(`~/Documents/${name}`);
  }, [open, initialUrl, usePicker]);

  useEffect(() => {
    if (activeIndex < 0) return;
    document
      .getElementById(`${listboxId}-opt-${activeIndex}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listboxId]);

  function handleUrlChange(value: string) {
    setUrlInput(value);
    setListOpen(true);
    setActiveIndex(-1);
    if (usePicker) return;
    const name = extractRepoName(value);
    if (name) setLocalPath(`~/Documents/${name}`);
  }

  function handleRepoSelect(repo: RepoEntry) {
    setUrlInput(repo.clone_url);
    if (usePicker) return;
    const name = repo.full_name.split('/')[1];
    setLocalPath(`~/Documents/${name}`);
  }

  async function handleClone() {
    const trimmedUrl = urlInput.trim();
    if (!trimmedUrl) {
      toast.error(t`Enter a repository URL or owner/repo`);
      return;
    }

    let dir = localPath || '';
    if (pickParentFolder) {
      setCloning(true);
      const parent = await pickParentFolder();
      if (!parent) {
        setCloning(false);
        return;
      }
      const name = extractRepoName(trimmedUrl);
      dir = `${parent.replace(/\/$/, '')}/${name}`;
    } else {
      setCloning(true);
    }

    const toastId = toast.loading(t`Starting clone`, { duration: Number.POSITIVE_INFINITY });
    toastIdRef.current = toastId;

    const handle = resolvedTransport.start({
      url: trimmedUrl,
      dir,
    });
    cancelRef.current = handle.cancel;

    try {
      const iter = handle.events[Symbol.asyncIterator]();
      let sawTerminal = false;
      let result = await iter.next();
      while (!result.done) {
        const event = result.value;
        if (event.type === 'progress') {
          const label = t(phaseLabel(event.phase));
          toast.loading(`${label} — ${event.pct}%`, { id: toastId });
        } else if (event.type === 'complete') {
          sawTerminal = true;
          toast.success(t`Clone complete — opening project`, { id: toastId });
          onOpenChange(false);
          setCloning(false);
          cancelRef.current = null;
          const port = 'port' in event ? event.port : undefined;
          if (onCloneComplete) {
            onCloneComplete({ port, dir: event.dir });
          } else if (port !== undefined) {
            window.location.href = `http://localhost:${port}`;
          }
          return;
        } else if (event.type === 'error') {
          sawTerminal = true;
          const cloneError = event.message;
          toast.error(t`Clone failed: ${cloneError}`, { id: toastId });
          setCloning(false);
          cancelRef.current = null;
          return;
        }
        result = await iter.next();
      }
      if (!sawTerminal) {
        toast.error(t`Clone stream ended unexpectedly — check if the clone completed`, {
          id: toastId,
        });
        setCloning(false);
        cancelRef.current = null;
      }
    } catch (err) {
      console.error('[CloneDialog] clone iteration failed:', err);
      toast.error(t`Clone failed — connection error`, { id: toastId });
      setCloning(false);
      cancelRef.current = null;
    }
  }

  function handleCancel() {
    cancelRef.current?.();
    cancelRef.current = null;
    setCloning(false);
    toast.dismiss(toastIdRef.current ?? undefined);
  }

  function handleClose(nextOpen: boolean) {
    if (cloning) return;
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setUrlInput('');
      if (!usePicker) setLocalPath('');
      setListOpen(false);
      setActiveIndex(-1);
    }
  }

  function selectRepo(repo: RepoEntry) {
    handleRepoSelect(repo);
    setListOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  const checkingAuth = isSignedIn === null;
  const repoListLoading = checkingAuth || (loadingRepos && repos === null);
  const query = urlInput.trim().toLowerCase();
  const suggestions = (repos ?? []).filter((r) =>
    `${r.full_name} ${r.clone_url}`.toLowerCase().includes(query),
  );
  const queryLooksLikeUrl = /:\/\/|^git@|\.git$/i.test(urlInput.trim());
  const showEmptyState =
    isSignedIn === true && repos !== null && suggestions.length === 0 && !queryLooksLikeUrl;
  const popoverOpen =
    listOpen &&
    isSignedIn !== false &&
    !cloning &&
    (repoListLoading || suggestions.length > 0 || showEmptyState);
  const suggestionCount = suggestions.length;
  const loadingId = `${listboxId}-loading`;

  useEffect(() => {
    setActiveIndex((i) => (i >= suggestionCount ? suggestionCount - 1 : i));
  }, [suggestionCount]);

  function handleComboKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (cloning) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!popoverOpen) {
        setListOpen(true);
        return;
      }
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      if (popoverOpen && activeIndex >= 0 && activeIndex < suggestions.length) {
        e.preventDefault();
        selectRepo(suggestions[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      if (popoverOpen) {
        e.preventDefault();
        e.stopPropagation();
        setListOpen(false);
        setActiveIndex(-1);
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <Trans>Clone from GitHub</Trans>
          </DialogTitle>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <label htmlFor="clone-source" className="text-sm font-medium">
                <Trans>Repository</Trans>
              </label>

              {isSignedIn !== false ? (
                <Popover open={popoverOpen} onOpenChange={setListOpen}>
                  <PopoverAnchor asChild>
                    <Input
                      id="clone-source"
                      ref={inputRef}
                      role="combobox"
                      aria-expanded={popoverOpen}
                      aria-controls={
                        popoverOpen ? (repoListLoading ? loadingId : listboxId) : undefined
                      }
                      aria-activedescendant={
                        activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined
                      }
                      aria-autocomplete="list"
                      autoComplete="off"
                      placeholder={t`Paste URL, owner/repo, or search your repos`}
                      value={urlInput}
                      onChange={(e) => handleUrlChange(e.target.value)}
                      onFocus={() => setListOpen(true)}
                      onKeyDown={handleComboKeyDown}
                      disabled={cloning}
                    />
                  </PopoverAnchor>
                  <PopoverContent
                    align="start"
                    sideOffset={4}
                    className="w-(--radix-popover-trigger-width) max-h-56 overflow-y-auto overscroll-y-contain subtle-scrollbar p-0"
                    data-ok-declines-keyboard=""
                    onOpenAutoFocus={(e) => e.preventDefault()}
                    onCloseAutoFocus={(e) => e.preventDefault()}
                    onInteractOutside={(e) => {
                      if (inputRef.current?.contains(e.target as Node)) e.preventDefault();
                    }}
                    onWheel={(e) => e.stopPropagation()}
                    onTouchMove={(e) => e.stopPropagation()}
                  >
                    {repoListLoading ? (
                      <output
                        id={loadingId}
                        className="flex flex-col gap-1.5 px-3 py-2"
                        aria-label={t`Loading repositories`}
                      >
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="h-4 w-1/2" />
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-4 w-2/5" />
                      </output>
                    ) : (
                      <div
                        id={listboxId}
                        role="listbox"
                        aria-label={t`Your repositories`}
                        className="py-1"
                      >
                        {suggestions.length === 0 ? (
                          <div
                            role="presentation"
                            className="px-3 py-2 text-xs text-muted-foreground"
                          >
                            {repos && repos.length === 0 ? (
                              <Trans>No repositories found on your GitHub account.</Trans>
                            ) : (
                              <Trans>No matching repositories.</Trans>
                            )}
                          </div>
                        ) : (
                          suggestions.map((repo, i) => (
                            // biome-ignore lint/a11y/useKeyWithClickEvents: WAI-ARIA combobox pattern — keyboard is handled on the input (Arrow/Enter via handleComboKeyDown) and routed to the highlighted option through aria-activedescendant; per-option key handlers would double-fire.
                            <div
                              key={repo.full_name}
                              id={`${listboxId}-opt-${i}`}
                              role="option"
                              tabIndex={-1}
                              aria-selected={i === activeIndex}
                              onMouseDown={(e) => e.preventDefault()}
                              onMouseEnter={() => setActiveIndex(i)}
                              onClick={() => selectRepo(repo)}
                              className={cn(
                                'flex cursor-default items-center gap-2 px-3 py-1.5 text-sm',
                                i === activeIndex && 'bg-accent text-accent-foreground',
                              )}
                            >
                              {repo.private ? (
                                <>
                                  <LockIcon
                                    className="size-3.5 shrink-0 text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                  <span className="sr-only">
                                    <Trans>Private repository</Trans>
                                  </span>
                                </>
                              ) : (
                                <>
                                  <GlobeIcon
                                    className="size-3.5 shrink-0 text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                  <span className="sr-only">
                                    <Trans>Public repository</Trans>
                                  </span>
                                </>
                              )}
                              <span className="truncate">{repo.full_name}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              ) : (
                <>
                  <Input
                    id="clone-source"
                    placeholder={t`https://github.com/owner/repo or owner/repo`}
                    value={urlInput}
                    onChange={(e) => handleUrlChange(e.target.value)}
                    disabled={cloning}
                  />
                  <div className="flex items-center gap-2 text-1sm text-muted-foreground">
                    <span>
                      <Trans>Browse your repos:</Trans>
                    </span>
                    <Button
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => onSignIn?.()}
                      disabled={cloning}
                    >
                      <Trans>Connect GitHub</Trans>
                    </Button>
                  </div>
                </>
              )}
            </div>

            {!usePicker && (
              <div className="flex flex-col gap-2">
                <label htmlFor="clone-path" className="text-sm font-medium">
                  <Trans>Local path</Trans>
                </label>
                <Input
                  id="clone-path"
                  placeholder="~/Documents/repo-name"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  disabled={cloning}
                />
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter>
          {cloning ? (
            <Button variant="outline" className="font-mono uppercase" onClick={handleCancel}>
              <Trans>Cancel</Trans>
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                className="font-mono uppercase"
                onClick={() => handleClose(false)}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button
                onClick={() => void handleClone()}
                disabled={!urlInput.trim()}
                aria-describedby={usePicker ? 'clone-picker-hint' : undefined}
              >
                <Trans>Clone</Trans>
              </Button>
              {usePicker && (
                <span id="clone-picker-hint" className="sr-only">
                  <Trans>Opens a folder picker to choose where to clone the repository.</Trans>
                </span>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

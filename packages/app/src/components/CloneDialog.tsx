/**
 * CloneDialog — dialog for cloning a GitHub repo into a new OpenKnowledge project.
 *
 * Supports:
 *   - Editable combobox input: paste URL, type owner/repo shorthand, or — when
 *     signed in — type to filter your repos. Matches appear in a floating
 *     Popover listbox anchored under the input (portaled, so the modal height
 *     stays fixed); selecting a row fills the input and closes the list.
 *     Keyboard: ArrowUp/Down to move, Enter to pick, Escape to close.
 *   - Authenticated repo browse when signed in (GET /api/local-op/auth/repos)
 *   - Native folder picker on Clone (when `pickParentFolder` provided): clones into
 *     `<picked>/<repo-name>`. Cancelling the picker leaves the dialog open with the
 *     URL still filled. Web/CLI callers without the picker fall back to a text input.
 *   - Clone via POST /api/local-op/clone (NDJSON streaming progress)
 *   - Sign-in integration: onSignIn prop opens AuthModal
 *   - On complete: redirect to the new server port
 */
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

/** Extract repo name from a URL or owner/repo shorthand. */
function extractRepoName(input: string): string {
  const trimmed = input.trim();
  // owner/repo shorthand
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
  /** Called when "Connect GitHub" is clicked. */
  onSignIn?: () => void;
  /**
   * Called when the clone completes successfully. When provided, the dialog
   * does NOT redirect via `window.location.href` — the caller takes over
   * navigation. Used by the Electron Navigator to spawn a new editor window
   * at `dir` instead of navigating the launcher itself to the new dev port.
   *
   * Shape is the flattened union of the two transport `complete` variants:
   * HTTP relay emits `{port, dir}`; IPC main emits `{dir}` only. `dir` is
   * always present (server-side guarantee); `port` is HTTP-only.
   */
  onCloneComplete?: (info: { port?: number; dir: string }) => void;
  /**
   * Transport for the clone subprocess. Defaults to the HTTP path (POST
   * /api/local-op/clone) so existing editor / web callers don't change.
   * The Project Navigator passes an IPC transport because its window has
   * no backing API server.
   */
  transport?: CloneTransport;
  /**
   * Transport for the one-shot auth-status / repos queries. Defaults to
   * the HTTP path (POST /api/local-op/auth/{status,repos}). Navigator
   * passes an IPC transport — without it the queries 404 on the renderer
   * dev server and the dialog persistently shows the Sign-in button even
   * when the user is signed in.
   */
  authQueryTransport?: AuthQueryTransport;
  /**
   * Optional native folder-picker. When provided (Electron Navigator), the
   * dialog hides its Local-path text field and instead fires the picker on
   * Clone — the picked folder becomes the parent and the repo clones into
   * `<picked>/<repo-name>`. Resolving to `null` (user cancelled the picker)
   * leaves the dialog open with the URL still filled in. When omitted
   * (web/CLI distribution), the dialog falls back to a basic text input.
   */
  pickParentFolder?: () => Promise<string | null>;
  /**
   * Optional URL to seed into the input field on dialog open. Used by the
   * share-receive Q3 path to pre-fill the wizard with the share's
   * `<owner>/<repo>` clone URL. Re-applies whenever this prop changes while
   * the dialog is open. Triggers the same name-derivation as user input.
   */
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

  // Check auth status when the dialog opens. The transport defaults to the
  // HTTP path; Navigator passes an IPC transport because its window has no
  // backing API server (apiOrigin === '') — the HTTP fetch would 404 on the
  // renderer dev server and the dialog would persistently show "Connect GitHub".
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
        // An unreachable check is not a confirmed sign-out, so leave the shared
        // cache untouched — Settings → Account writes/reads it too, and flipping
        // it to false here would wrongly revert that surface on a transient
        // failure. Fall back to the plain input for this render only.
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

  // Seed the URL input from `initialUrl` whenever the dialog opens (or the
  // prop changes while open). The receive-flow Q3 path passes the share's
  // canonical clone URL so the wizard arrives ready-to-clone — the user only
  // picks the parent folder. Inline (not delegated to handleUrlChange) so the
  // React Compiler doesn't trip on the use-before-declare hoist.
  useEffect(() => {
    if (!open) return;
    if (!initialUrl) return;
    setUrlInput(initialUrl);
    if (usePicker) return;
    const name = extractRepoName(initialUrl);
    if (name) setLocalPath(`~/Documents/${name}`);
  }, [open, initialUrl, usePicker]);

  // Keep the keyboard-highlighted suggestion scrolled into view.
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
      // Set cloning before awaiting the picker so a second click on the
      // (now-disabled) Clone button can't open a second picker or queue a
      // second clone.
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
      // Manual iterator drive — React Compiler (BuildHIR) does not yet
      // support `for await ... of` lowering.
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
        // Stream ended without a terminal 'complete' or 'error' event.
        toast.error(t`Clone stream ended unexpectedly — check if the clone completed`, {
          id: toastId,
        });
        setCloning(false);
        cancelRef.current = null;
      }
    } catch (err) {
      // Log so non-transport exceptions (e.g. an `onCloneComplete` callback
      // throwing) aren't lost behind the generic toast message.
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
    if (cloning) return; // prevent close while cloning
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

  // While auth status is still unknown (null), treat it as the signed-in branch
  // so signed-in users never see the "Connect GitHub" CTA flash before the
  // status check resolves. The suggestion list shows a loading state meanwhile.
  const checkingAuth = isSignedIn === null;
  const repoListLoading = checkingAuth || (loadingRepos && repos === null);
  const query = urlInput.trim().toLowerCase();
  const suggestions = (repos ?? []).filter((r) =>
    `${r.full_name} ${r.clone_url}`.toLowerCase().includes(query),
  );
  // When the field holds a pasted clone URL (not a search term), suppress the
  // "no matches" empty state — the user is entering a target, not browsing.
  const queryLooksLikeUrl = /:\/\/|^git@|\.git$/i.test(urlInput.trim());
  // Show an empty-state message (rather than letting the popover blink shut)
  // once repos have loaded and nothing matches: explains zero-repo accounts and
  // genuine no-match searches without flickering on the load→empty transition.
  const showEmptyState =
    isSignedIn === true && repos !== null && suggestions.length === 0 && !queryLooksLikeUrl;
  // Popover floats over the modal (portaled), so opening it never grows the
  // dialog. Open while loading, when there are matches, or to show empty state.
  const popoverOpen =
    listOpen &&
    isSignedIn !== false &&
    !cloning &&
    (repoListLoading || suggestions.length > 0 || showEmptyState);
  const suggestionCount = suggestions.length;
  // aria-controls must reference the live popup; during loading that's the
  // status element, otherwise the listbox.
  const loadingId = `${listboxId}-loading`;

  // Clamp the highlight if the suggestion list shrinks under it — e.g. repos
  // finish loading (or the filter narrows) while the user is mid-keyboard-nav —
  // so aria-activedescendant never points at a row that no longer exists. The
  // updater returns `i` unchanged when still valid, so React bails out (no extra
  // render) in the common case.
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
      // Floor at -1 (not 0): ArrowUp off the first row clears the highlight and
      // returns to free-text entry, per the WAI-ARIA combobox keyboard model.
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      if (popoverOpen && activeIndex >= 0 && activeIndex < suggestions.length) {
        e.preventDefault();
        selectRepo(suggestions[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      if (popoverOpen) {
        // Close the suggestion list first, not the whole dialog.
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
                // Editable combobox: the input stays a normal text field (paste a
                // URL or type owner/repo), and matching repos appear in a floating
                // Popover listbox anchored under it. The list is portaled, so it
                // overlays the modal instead of growing it, and closes on select.
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
                    // Keep focus in the input — the list is a passive suggestion
                    // surface, not a focus target. And don't let a pointer-down on
                    // the input itself (the anchor) count as an outside-click close.
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
                      // Single listbox container so aria-controls (which points at
                      // listboxId whenever the popover is open and not loading)
                      // always resolves to a role="listbox" element — empty state
                      // included. The empty message is a role="presentation" child,
                      // which the listbox content model permits.
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
                              // preventDefault on mousedown so the input keeps focus
                              // through the click; onClick then commits the choice.
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

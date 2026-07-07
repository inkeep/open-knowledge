/**
 * New-worktree dialog (worktree = window). Launched from the sidebar
 * ProjectSwitcher's "New worktree" item and the File → New worktree… menu.
 *
 * Dual-mode on a single branch field, disambiguated against the current
 * project's local branches (`branches`):
 *   - a name NOT among them → create that new branch off the current one;
 *   - a name that IS among them → check that existing branch out as a worktree.
 * Either way the worktree is auto-located at `<mainRoot>/.ok/worktrees/<branch>`
 * (the user picks only the branch — the location is chosen for them) and opened
 * in its own window via `bridge.project.open({ entryPoint: 'worktree' })`. The
 * existing branches surface as a styled, filter-as-you-type suggestion list
 * (NOT a native `<datalist>`, whose browser-default chrome doesn't match).
 *
 * Layout mirrors CreateProjectDialog: shadcn Dialog, a focused branch Input, a
 * mode-aware caption, Cancel + confirm footer.
 */

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
  /** Base branch a new worktree branches from (the current window's branch). */
  currentBranch: string | null;
  /**
   * Branch name to seed the field with when the dialog opens. Set when the
   * dialog is launched from the switcher flyout's "Create worktree …" action so
   * the typed query pre-fills; the standalone launchers pass nothing (`''`) to
   * open empty.
   */
  initialBranchName?: string;
  /**
   * Local branch names of the current project (from the cached worktree model).
   * A typed name matching one of these checks it out instead of creating; also
   * feeds the styled suggestion list for discoverable branch selection.
   */
  branches?: readonly string[];
  /**
   * Branch names that ALREADY have an open worktree (a non-null `worktreePath`
   * in the cached model). A typed name in this set is neither a fresh create nor
   * a first-time checkout — `worktree.create` returns the existing worktree path
   * (`created: false`) and opens it. The dialog surfaces this as a distinct
   * "already has a worktree" state so the copy/button don't misrepresent it as a
   * checkout.
   */
  existingWorktreeBranches?: ReadonlySet<string>;
  /**
   * Remote-tracking branch refs WITH their remote prefix (`origin/main`,
   * `origin/feature-x`) from the cached worktree model. Two roles:
   *   - a typed name whose bare form matches one of these BUT has no local
   *     branch is a remote-tracking checkout (a new local branch that tracks the
   *     remote ref), NOT a fresh divergent branch off stale HEAD;
   *   - every ref is selectable as a `--no-track` base for a new branch, so a
   *     feature branch can start from a fresh `origin/<x>` even when the local
   *     `<x>` is behind.
   */
  remoteBranches?: readonly string[];
  /**
   * Per-local-branch "commits behind origin" counts, keyed by local branch
   * name. Surfaced as a subtle "· N behind origin" hint on the matching local
   * base option to nudge toward a fresh `origin/<x>` base. A branch absent from
   * the map (no upstream / unknown) shows no hint; `0` shows none either (up to
   * date needs no nudge).
   */
  behindByBranch?: ReadonlyMap<string, number>;
}

/**
 * Base a new branch on either a LOCAL branch (`git worktree add -b … -- <name>`)
 * or a REMOTE ref (`git worktree add -b … origin/<name> --no-track`). `null` =
 * the current commit / HEAD (no base ref). Discriminated so the submit handler
 * routes the pick to `baseBranch` vs `baseRef` without re-parsing the string.
 */
type LocalBaseChoice = { readonly kind: 'local'; readonly name: string };
type RemoteBaseChoice = { readonly kind: 'remote'; readonly ref: string };
type BaseChoice = LocalBaseChoice | RemoteBaseChoice;
/** A chosen base, or `null` for the current commit / HEAD (no base ref). */
type BaseSelection = BaseChoice | null;

function baseSelectionLabel(sel: BaseSelection): string | null {
  if (sel === null) return null;
  return sel.kind === 'local' ? sel.name : sel.ref;
}

/**
 * Resolve the remote-tracking ref to check out for a typed branch name that has
 * no local branch. Returns `origin/<name>` when present (the default remote OK
 * flows key on — avoids the multi-remote DWIM `fatal: invalid reference`), else
 * the first `<remote>/<name>` ref whose bare name matches, else `null` (the name
 * isn't a remote branch → it's a fresh create).
 */
function findRemoteRef(name: string, remoteBranches: readonly string[]): string | null {
  if (name.length === 0) return null;
  const preferred = `origin/${name}`;
  if (remoteBranches.includes(preferred)) return preferred;
  return remoteBranches.find((ref) => stripRemotePrefix(ref) === name) ?? null;
}

/** Inline error copy per `WorktreeCreateResult` failure reason. */
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
    default:
      return msg`Couldn't create the worktree. Try a different name.`;
  }
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
  const [error, setError] = useState<MessageDescriptor | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const baseSearchRef = useRef<HTMLInputElement | null>(null);

  // Reset transient state + focus the input on open. `busy` MUST reset — the
  // success path closes without clearing it, so a stale `true` would leave the
  // next open's form disabled (same hazard CreateProjectDialog guards).
  // `base` resets to the current window's branch so each open starts from the
  // default base regardless of a prior session's pick. `branch` seeds from
  // `initialBranchName` so a flyout "Create worktree …" launch opens pre-filled;
  // the standalone launchers pass `''` and open empty.
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
  // A typed name that matches an existing local branch checks it out; anything
  // else creates a fresh branch (unless it's remote-only — see below). Drives
  // the confirm label + caption + the git call's `createBranch` flag.
  const isLocalBranch = trimmed.length > 0 && branches.includes(trimmed);
  // Remote-ONLY: the typed name has no local branch but a remote ref of the same
  // bare name exists. Checking it out must create a NEW LOCAL TRACKING branch off
  // the remote ref — never a fresh divergent branch off stale HEAD (which
  // silently discards remote history → push rejected / force-push over the real
  // branch). `remoteCheckoutRef` is the explicit ref to track, prefer `origin/`.
  const remoteCheckoutRef = isLocalBranch ? null : findRemoteRef(trimmed, remoteBranches);
  const isRemoteCheckout = remoteCheckoutRef !== null;
  // `isCheckout` now means "reuses an existing branch's history" — a local
  // checkout OR a remote-tracking checkout. Both skip the base selector (the
  // branch/ref IS the history source).
  const isCheckout = isLocalBranch || isRemoteCheckout;
  // A local checkout whose branch ALREADY has an open worktree — a strict subset
  // of local checkout. Here `create` just opens the existing worktree
  // (`created: false`); the copy + button say so rather than implying a fresh
  // checkout. The git call is unchanged (`createBranch: false`, no base).
  const isExistingWorktree = isLocalBranch && (existingWorktreeBranches?.has(trimmed) ?? false);
  // Existing branches to suggest, filtered as the user types. Prefix match
  // (not substring) — a substring filter surfaces unrelated branches whose
  // name merely contains the typed text (e.g. "main" matching a branch named
  // "...-germain-...").
  const suggestions = branches.filter((b) => b.toLowerCase().startsWith(trimmed.toLowerCase()));
  // Hidden once the field exactly matches an existing branch (or a remote-only
  // one): the checkout indicator above already communicates that, so the list is
  // redundant and would otherwise crowd out the caption/base selector below it.
  const showSuggestions = !busy && suggestions.length > 0 && !isCheckout;

  // Base choices for the create-mode selector. Local branches first
  // (`currentBranch` unioned in + deduped so the default is always selectable
  // even if the cached list hasn't caught up), then remote refs so a new branch
  // can start from a fresh `origin/<x>`.
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
  // Type-to-select filter for the base Popover — a pure picker filter (not the
  // create/checkout decision above), so a friendly case-insensitive SUBSTRING
  // match is fine here: "test" finds test-2/test-3, "origin" finds the remote
  // refs. Local-first ordering is preserved since both lists filter in place.
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
      // Route the typed name + base pick to the right git arm:
      //  - remote-only name → remote-tracking checkout (a new local branch that
      //    tracks `remoteCheckoutRef`); `createBranch` is true but the ref is the
      //    base, so `baseBranch`/`baseRef` are omitted;
      //  - local checkout → reuse the branch, no base;
      //  - fresh create → `baseBranch` (local base) or `baseRef` (remote base,
      //    `--no-track`), or neither (current commit / HEAD).
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
        setError(createErrorCopy(result.reason));
        setBusy(false);
        return;
      }
      // The current window's cached worktree model is now stale (a worktree was
      // created/located) — refresh it so this window's switcher + palette show it.
      refreshWorktrees();
      // Open the worktree in its own window. Close optimistically — the window
      // spawn can take a moment (server boot); keeping the dialog up races the
      // teardown, same posture as CreateProjectDialog's nested-open.
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
                {/* The sentence lives in ONE span so it's a single flex item that
                  flows/wraps normally — without this wrapper each text run + <code>
                  becomes its own flex item and the words scramble across columns. */}
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
            {/* Base-branch selector: only meaningful when creating a new branch.
              Checkout mode reuses an existing branch's history, so there's no
              base to choose. A shadcn Popover (not Radix Select/DropdownMenu):
              this Electron renderer delivers no real `pointerdown`, so those
              may not open — Popover opens on click, verified on this renderer. */}
            {!isCheckout ? (
              <div className="mt-1 flex flex-col gap-2">
                <Label id={baseLabelId} htmlFor={baseTriggerId}>
                  <Trans>Base branch</Trans>
                </Label>
                <Popover
                  open={baseOpen}
                  onOpenChange={(next) => {
                    setBaseOpen(next);
                    // Reset the filter on close so the next open starts fresh
                    // rather than carrying over a stale query.
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
                    // Popover-inside-Dialog: the Dialog's react-remove-scroll
                    // preventDefaults native scroll on portaled descendants
                    // (the popover renders to document.body). stopPropagation
                    // keeps the wheel/touch event from reaching those listeners
                    // so the list scrolls. https://github.com/radix-ui/primitives/issues/1159
                    onWheel={(e) => {
                      e.stopPropagation();
                    }}
                    onTouchMove={(e) => {
                      e.stopPropagation();
                    }}
                    // Radix focuses the content root by default on open; steal
                    // that focus for the search field so the user can type
                    // immediately, matching the branch-name field's focus-on-open.
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
                        // Radix's listbox composes arrow/typeahead handling on
                        // the content root — stopPropagation keeps those from
                        // swallowing keystrokes meant for the filter field.
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
                            {/* "N behind origin" hint: only when the branch has an
                              upstream AND has diverged (>0). Nudges toward the
                              fresh origin/<x> base below without shouting. */}
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
              <p
                id={errorId}
                role="alert"
                className="text-1sm text-destructive"
                data-testid="new-worktree-error"
              >
                {t(error)}
              </p>
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

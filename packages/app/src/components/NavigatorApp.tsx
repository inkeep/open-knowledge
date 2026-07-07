/**
 * Project Navigator — persistent-launcher UI shown when the desktop app
 * boots without a `lastOpenedProject`, OR when the user holds Option at
 * launch.
 *
 * Three primary cards (Clone from GitHub, Open folder on disk, Create new
 * project) above a Recent list. Every project pick spawns a NEW editor
 * window via `ok:project:open` IPC — no switch-in-place. Navigator window
 * stays open. Create new project opens an in-app `CreateProjectDialog`
 * inside the Navigator window rather than dispatching to a separate flow.
 *
 * Web / CLI distribution never reaches this component — it only renders
 * when `window.okDesktop?.config.mode === 'navigator'` (gated in
 * `packages/app/src/main.tsx`).
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { Folder, FolderOpenIcon, GitBranch, Loader2Icon, PlusIcon, XIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { type ComponentType, lazy, Suspense, useEffect, useState } from 'react';
import { useThemeBridge } from '@/hooks/use-theme-bridge';
import type {
  OkDesktopBridge,
  OkLocalOpAuthStatusResponse,
  OkProjectEntryPoint,
  RecentProjectEntry,
} from '@/lib/desktop-bridge-types';
import {
  resolveErrorMessage,
  runWithErrorStatePure as runWithErrorStatePureBase,
} from '@/lib/error-state';
import { createCloneController } from '@/lib/share/clone-controller';
import { ipcAuthQueryTransport } from '@/lib/transports/auth-query-transport';
import { ipcAuthTransport } from '@/lib/transports/auth-transport';
import { ipcCloneTransport } from '@/lib/transports/clone-transport';
import { cn } from '@/lib/utils';
import { AuthModal } from './AuthModal';
import { BetaBadge } from './BetaBadge';
import { CloneDialog } from './CloneDialog';
import { ConsentDialog } from './ConsentDialog';
import { CreateProjectDialog } from './CreateProjectDialog';
import { GithubIcon } from './icons/github';
import { OkIcon } from './icons/ok';
import { McpConsentDialog } from './McpConsentDialog';
import { basenameOf } from './project-switcher-recents';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

// Cold-path launcher surface: renders nothing until main fires
// `ok:share:received`. Lazy so its clone / auth-preflight / Q2-picker code
// (and the transports it pulls in) splits out of the main bundle.
const ShareReceiveDialog = lazy(() =>
  import('./ShareReceiveDialog').then((m) => ({ default: m.ShareReceiveDialog })),
);

// Re-exports for tests — keeping the surface here avoids churn in existing
// test files that import directly from NavigatorApp.tsx and keeps the
// shared-helper move transparent.
export { resolveErrorMessage };
export const runWithErrorStatePure = (
  fn: () => Promise<void>,
  fallback: string,
  setError: (msg: string | null) => void,
) => runWithErrorStatePureBase(fn, fallback, setError, 'NavigatorApp');

type RecentProject = RecentProjectEntry;

export function removeRecentFromList(
  recents: readonly RecentProjectEntry[],
  path: string,
): RecentProjectEntry[] {
  return recents.filter((recent) => recent.path !== path);
}

export function NavigatorApp({ bridge }: { bridge: OkDesktopBridge }) {
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [recentBranches, setRecentBranches] = useState<Map<string, string | null>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [returnToCloneAfterAuth, setReturnToCloneAfterAuth] = useState(false);
  // Pending share-receive sign-in resolver — the share dialog's controller
  // awaits this when the user clicks "Connect GitHub." Resolved with the
  // new auth status on success, `null` if the user dismissed the modal.
  // We re-use the existing AuthModal mount (one modal at a time) rather than
  // spinning up a second instance. State (not ref) — React Compiler rejects
  // refs captured by factory closures called during render.
  const [shareSignInResolver, setShareSignInResolver] = useState<
    ((status: OkLocalOpAuthStatusResponse | null) => void) | null
  >(null);
  // Electron host gates the macOS drag-region treatment. With
  // `titleBarStyle: 'hiddenInset'` the launcher window has no OS-drawn
  // titlebar — without an explicit drag region the user has nowhere to
  // grab the window. Scoped to the launcher's header row only so empty
  // space below the cards / around the recent list stays non-draggable
  // (matches the macOS "title bar zone" convention). Detection idiom
  // matches EditorHeader / FileSidebar.
  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  // Mirror EditorPane's auth-modal state shape so the two surfaces stay
  // structurally identical. Today Navigator only ever opens with step
  // 'auth' (no identity-prompt entry point), but keeping the state +
  // prop wired prevents silent divergence if Navigator gains an identity
  // surface later (e.g. profile menu).
  const [authInitialStep, setAuthInitialStep] = useState<'auth' | 'identity'>('auth');
  const { theme: themeValue } = useTheme();
  const { t } = useLingui();

  // Push the user-intent theme to Electron main and release the cold-launch
  // show-gate via the shared `useThemeBridge` hook. Same hook drives
  // `ConfigProvider` so both window kinds release the gate the same way;
  // theme value comes from `next-themes` here (Navigator has no CRDT),
  // from the merged config in the editor flow.
  //
  // Fall back to `'system'` for symmetry with `ConfigProvider`. `next-themes`
  // does default to `'system'` here today (the launcher window mounts
  // `<ThemeProvider defaultTheme="system">` in `main.tsx`), so this is
  // operationally a no-op — but the hook's contract requires a known enum
  // to fire `signalThemeApplied`, and any future refactor that drops the
  // ThemeProvider default or sources `themeValue` from a different surface
  // would otherwise stall the show-gate's 5 s safety timeout.
  useThemeBridge(bridge, themeValue ?? 'system');

  useEffect(() => {
    let cancelled = false;
    // Promise-chain instead of try/catch/finally — React Compiler (BuildHIR)
    // does not yet support `finally` clauses; `.finally(...)` on the Promise
    // is equivalent and compiler-safe.
    bridge.project
      .listRecent()
      .then(async (result) => {
        if (cancelled) return;
        setRecents(result);
        // Best-effort batched HEAD-branch read for every non-missing entry.
        // `readHeadBranch` is a pure-fs read (no git subprocess) and never
        // throws; the IPC layer can still reject if the bridge is unavailable.
        const eligible = result.filter((r) => !r.missing);
        const entries = await Promise.all(
          eligible.map(async (r): Promise<[string, string | null]> => {
            try {
              const { currentBranch } = await bridge.project.readHeadBranch(r.path);
              return [r.path, currentBranch];
            } catch {
              return [r.path, null];
            }
          }),
        );
        if (cancelled) return;
        // Merge instead of replace so a user-initiated `onRemoveRecent`
        // landing while the fetch was in-flight doesn't get resurrected.
        setRecentBranches((prev) => {
          const next = new Map(prev);
          for (const [path, branch] of entries) next.set(path, branch);
          return next;
        });
      })
      .catch((err) => {
        console.error('[NavigatorApp] listRecent failed:', err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t`Failed to load recent projects.`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, t]);

  // File → New project… (the `new-project` menu action) opens the same
  // CreateProjectDialog the "Create new project" card opens. The application
  // menu fires to whichever window is focused, so the Navigator must react to
  // it too — not just the editor window's App-root trigger.
  useEffect(() => {
    return bridge.onMenuAction((action) => {
      if (action === 'new-project') setCreateDialogOpen(true);
      if (action === 'close-active-tab-or-window') window.close();
    });
  }, [bridge]);

  /**
   * Wrap any bridge call in a visible error state. Without this the IPC
   * rejection (utility failed to boot, bad folder, dialog rejected) lands as
   * an unhandled promise rejection and the UI stays frozen in its pre-click
   * state — no feedback, no retry path. Delegates to the pure
   * `runWithErrorStatePure` helper so the rejection-handling logic can be
   * unit-tested without React.
   */
  const runWithErrorState = (fn: () => Promise<void>, fallback: string) =>
    runWithErrorStatePure(fn, fallback, setError);

  const onClone = () => setCloneDialogOpen(true);

  const onOpenFolder = () =>
    runWithErrorState(async () => {
      const path = await bridge.dialog.openFolder();
      if (!path) return;
      await openProject(bridge, path, 'pick-existing');
    }, t`Failed to open folder.`);

  const onCreate = () => setCreateDialogOpen(true);

  const onOpenRecent = (path: string) =>
    runWithErrorState(async () => {
      await openProject(bridge, path, 'recents');
    }, t`Failed to open project.`);

  const onRemoveRecent = (path: string) =>
    runWithErrorState(async () => {
      await bridge.project.removeRecent(path);
      setRecents((current) => removeRecentFromList(current, path));
      setRecentBranches((current) => {
        if (!current.has(path)) return current;
        const next = new Map(current);
        next.delete(path);
        return next;
      });
    }, t`Failed to remove project.`);

  return (
    // Two-layer split: outer fills the full window (bg color); inner is a
    // full-window-width drag strip at top + a centered content column below.
    //
    // The chrome row is intentionally a thin empty strip (h-9, ~36px) at
    // the top. It owns `-webkit-app-region: drag` so the macOS title-bar
    // zone (where traffic lights sit) is grabbable. Drag stays scoped to
    // this strip — applying it to the outer container turns clicks on
    // empty space below into accidental window drags.
    //
    // The visible content (OK icon + title + 3 cards + optional Recents)
    // lives in a separate `flex-1` column below the chrome row, with the
    // inner content block using `my-auto` so it vertically centers when it
    // fits, and gracefully top-aligns when many recents push it past the
    // available height (recents scroll inside their own `min-h-0
    // overflow-y-auto` container in that case).
    //
    // `overflow-hidden` on the content column + `shrink-0` on every
    // fixed-height item keeps the primary affordances on-screen at the
    // default 840×600 Navigator window size.
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-primary-foreground dark:bg-background text-foreground">
      {/* Chrome row is absolutely positioned so it doesn't push content
          out of geometric center. The full window height participates in
          the my-auto centering math below; the drag strip just overlays
          the top 36 px (covering the traffic-light zone). `pointer-events-
          none` keeps stray clicks from being captured by this empty overlay;
          `-webkit-app-region:drag` operates at Electron's compositor layer
          BELOW pointer-events, so window-drag still works. */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-9 ${
          isElectronHost ? '[-webkit-app-region:drag]' : ''
        }`}
        data-electron-drag={isElectronHost ? '' : undefined}
        data-testid="nav-chrome-row"
      />
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden px-12 py-12">
        <div className="my-auto flex min-h-0 flex-col space-y-10">
          <header className="shrink-0 flex-wrap flex items-center gap-2.5">
            <OkIcon className="size-12 shrink-0" />
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <h1 className="font-medium text-xl tracking-tight">OpenKnowledge</h1>
                <BetaBadge />
              </div>
              <p className="text-muted-foreground text-xs font-mono">v{bridge.appVersion}</p>
            </div>
          </header>

          <section className="grid shrink-0 sm:grid-cols-3 gap-3">
            <NavigatorCard
              title={t`Create new project`}
              description={t`Start a new OpenKnowledge project.`}
              onClick={onCreate}
              dataTestId="nav-create-new"
              Icon={PlusIcon}
            />
            <NavigatorCard
              title={t`Open folder on disk`}
              description={t`Use a folder you already have.`}
              onClick={onOpenFolder}
              dataTestId="nav-open"
              Icon={FolderOpenIcon}
            />
            <NavigatorCard
              title={t`Clone from GitHub`}
              description={t`Bring a remote repository onto this machine.`}
              onClick={onClone}
              dataTestId="nav-clone"
              Icon={GithubIcon}
            />
          </section>

          {error !== null ? (
            <div
              className="flex shrink-0 items-start justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2"
              data-testid="nav-error-banner"
              role="alert"
            >
              <span className="text-red-700 text-xs dark:text-red-300">{error}</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => setError(null)}
                className="h-auto p-0 text-red-700 text-xs dark:text-red-300"
                data-testid="nav-error-dismiss"
              >
                <Trans>Dismiss</Trans>
              </Button>
            </div>
          ) : null}

          {loading ? (
            <section className="flex shrink-0 flex-col items-center">
              <Loader2Icon className="size-4 animate-spin text-muted-foreground/60" />
            </section>
          ) : recents.length > 0 ? (
            <section className="flex min-h-0 flex-col">
              <h2 className="mb-2 shrink-0 font-medium text-muted-foreground font-mono text-xs uppercase tracking-wide">
                <Trans>Recent</Trans>
              </h2>
              <ul
                className="min-h-0 max-h-48 subtle-scrollbar scroll-fade-mask overflow-y-auto space-y-0.5 -mx-4"
                data-testid="nav-recent-list"
              >
                {recents.map((r) => (
                  <RecentRow
                    key={r.path}
                    project={r}
                    branch={recentBranches.get(r.path) ?? null}
                    onOpen={() => onOpenRecent(r.path)}
                    onRemove={() => onRemoveRecent(r.path)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>

      {/* First-launch consent dialog — self-gates on the shared
          `mcpConsentStore` snapshot, renders nothing until main fires
          `ok:mcp-wiring:show`. Mounted identically in App.tsx. */}
      <McpConsentDialog />

      {/* Per-project consent dialog — self-gates on the shared `consentStore`
          snapshot, renders nothing until main fires `ok:onboarding:show`
          for a Pick Existing / Recents / deep-link / drag-drop pick that
          resolves to a fresh kind. Navigator-only. */}
      <ConsentDialog />

      <CreateProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        bridge={bridge}
      />

      <AuthModal
        open={authModalOpen}
        onOpenChange={(next) => {
          setAuthModalOpen(next);
          if (!next) {
            setReturnToCloneAfterAuth(false);
            // If a share-receive sign-in was pending and the modal closed
            // without onSuccess firing, the user cancelled — resolve with
            // null so the share dialog can stay on its prior state.
            if (shareSignInResolver) {
              shareSignInResolver(null);
              setShareSignInResolver(null);
            }
          }
        }}
        transport={ipcAuthTransport(bridge)}
        queryTransport={ipcAuthQueryTransport(bridge)}
        identityPrompt={authInitialStep === 'identity'}
        onSuccess={(result) => {
          setAuthModalOpen(false);
          if (returnToCloneAfterAuth) {
            setReturnToCloneAfterAuth(false);
            setCloneDialogOpen(true);
          }
          // Share-receive sign-in completion path (independent of the
          // CloneDialog's returnToCloneAfterAuth flag).
          if (shareSignInResolver) {
            shareSignInResolver({
              authenticated: true,
              host: 'github.com',
              login: result.login,
            });
            setShareSignInResolver(null);
          }
        }}
      />
      <CloneDialog
        open={cloneDialogOpen}
        onOpenChange={setCloneDialogOpen}
        transport={ipcCloneTransport(bridge)}
        authQueryTransport={ipcAuthQueryTransport(bridge)}
        pickParentFolder={() => bridge.dialog.openFolder()}
        onSignIn={() => {
          setCloneDialogOpen(false);
          setAuthInitialStep('auth');
          setReturnToCloneAfterAuth(true);
          setAuthModalOpen(true);
        }}
        onCloneComplete={({ dir }) => {
          // Navigator stays open; spawn the cloned project in a new editor
          // window with the 'pick-existing' entry point — cloned content
          // lands like a freshly-picked existing folder, so the consent
          // dialog gate is the right surface for the user to review scope
          // before scaffolding.
          void runWithErrorState(
            () => openProject(bridge, dir, 'pick-existing'),
            t`Failed to open cloned project.`,
          );
        }}
      />

      {/* Share-receive dialog. Self-gates on the shared
          shareReceiveStore — renders nothing until main fires
          `ok:share:received`. Q1 hits silently dispatch project.open;
          misses surface the Q2 picker with auth pre-flight + a
          streamlined clone (folder picker → progress toast → done) via
          the shared cloneController. IPC transports for the Navigator
          window (no backing API server). */}
      <Suspense fallback={null}>
        <ShareReceiveDialog
          bridge={bridge}
          cloneController={createCloneController({
            bridge,
            authQueryTransport: ipcAuthQueryTransport(bridge),
            cloneTransport: ipcCloneTransport(bridge),
            openSignIn: () =>
              new Promise<OkLocalOpAuthStatusResponse | null>((resolve) => {
                // Wrap in function so useState doesn't treat `resolve` as an updater.
                setShareSignInResolver(() => resolve);
                setAuthModalOpen(true);
              }),
          })}
        />
      </Suspense>
    </div>
  );
}

interface NavigatorCardProps {
  title: string;
  description: string;
  onClick: () => void;
  dataTestId?: string;
  Icon?: ComponentType<{ className?: string }>;
}

function NavigatorCard({ title, description, onClick, dataTestId, Icon }: NavigatorCardProps) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      data-testid={dataTestId}
      className="h-auto flex-col items-start justify-start gap-1.5 whitespace-normal bg-card px-4 py-3.5 text-left"
    >
      <div className="flex items-center gap-2">
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
        <span className="font-medium text-gray-700 dark:text-foreground text-sm">{title}</span>
      </div>
      <span className="line-clamp-2 text-muted-foreground text-xs leading-snug">{description}</span>
    </Button>
  );
}

function RecentRow({
  project,
  branch,
  onOpen,
  onRemove,
}: {
  project: RecentProject;
  branch: string | null;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const { name: projectName } = project;
  const isWorktree = project.isLinkedWorktree === true;
  // Branch chip shows the worktree's own branch, else the project's current branch.
  const rowBranch = isWorktree ? (project.branch ?? branch) : branch;
  return (
    <li className="group flex items-center justify-between rounded-lg hover:bg-accent">
      <Button
        type="button"
        variant="ghost"
        onClick={onOpen}
        disabled={project.missing}
        className={cn(
          'h-auto min-w-0 flex-1 justify-between gap-3 py-3.5 pl-4 pr-2 text-left hover:bg-transparent',
          project.missing && 'opacity-50',
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          {/* Uniform folder icon for every row — worktree vs project is conveyed
            by the worktree pill + the branch chip, not by the icon. */}
          <Folder aria-hidden="true" className="size-[18px] shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-1 truncate">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium text-sm text-gray-700 dark:text-foreground">
                {project.name}
              </span>
              {isWorktree ? (
                <Badge
                  variant="secondary"
                  className="shrink-0 gap-1 rounded-full border-transparent bg-green-600/10 px-2 py-0 font-medium text-2xs text-green-800 dark:bg-green-400/10 dark:text-green-400"
                >
                  <GitBranch aria-hidden="true" className="size-2.5" />
                  <Trans>worktree</Trans>
                </Badge>
              ) : null}
            </div>
            <span
              className="truncate w-full text-muted-foreground text-xs"
              title={isWorktree ? (project.mainRoot ?? '') : project.path}
            >
              {isWorktree ? <Trans>of {basenameOf(project.mainRoot ?? '')}</Trans> : project.path}
            </span>
          </div>
        </div>
        {project.missing ? (
          <Badge className="text-2xs rounded-sm" variant="warning">
            <Trans>Missing</Trans>
          </Badge>
        ) : rowBranch != null ? (
          <span
            className="flex max-w-[40%] items-center gap-1 text-muted-foreground text-xs"
            data-testid={`nav-recent-branch-${project.path}`}
          >
            <GitBranch aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate font-mono">{rowBranch}</span>
          </span>
        ) : null}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        aria-label={t`Remove ${projectName} from recent projects`}
        title={t`Remove from recent projects`}
        className="pointer-events-none mr-2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
        data-testid={`nav-recent-remove-${project.path}`}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </li>
  );
}

async function openProject(
  bridge: OkDesktopBridge,
  path: string,
  entryPoint: OkProjectEntryPoint,
): Promise<void> {
  await bridge.project.open({ path, target: 'new-window', entryPoint });
}

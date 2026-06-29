import { Trans, useLingui } from '@lingui/react/macro';
import { FolderOpenIcon, GitBranch, Loader2Icon, PlusIcon, XIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { type ComponentType, useEffect, useState } from 'react';
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
import { ShareReceiveDialog } from './ShareReceiveDialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

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
  const [shareSignInResolver, setShareSignInResolver] = useState<
    ((status: OkLocalOpAuthStatusResponse | null) => void) | null
  >(null);
  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  const [authInitialStep, setAuthInitialStep] = useState<'auth' | 'identity'>('auth');
  const { theme: themeValue } = useTheme();
  const { t } = useLingui();

  useThemeBridge(bridge, themeValue ?? 'system');

  useEffect(() => {
    let cancelled = false;
    bridge.project
      .listRecent()
      .then(async (result) => {
        if (cancelled) return;
        setRecents(result);
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

  useEffect(() => {
    return bridge.onMenuAction((action) => {
      if (action === 'new-project') setCreateDialogOpen(true);
      if (action === 'close-active-tab-or-window') window.close();
    });
  }, [bridge]);

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
      <ShareReceiveDialog
        bridge={bridge}
        cloneController={createCloneController({
          bridge,
          authQueryTransport: ipcAuthQueryTransport(bridge),
          cloneTransport: ipcCloneTransport(bridge),
          openSignIn: () =>
            new Promise<OkLocalOpAuthStatusResponse | null>((resolve) => {
              setShareSignInResolver(() => resolve);
              setAuthModalOpen(true);
            }),
        })}
      />
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
  return (
    <li className="group flex items-center justify-between rounded-lg hover:bg-accent">
      <Button
        type="button"
        variant="ghost"
        onClick={onOpen}
        disabled={project.missing}
        className={cn(
          'h-auto min-w-0 flex-1 justify-between gap-2 py-3.5 pl-4 pr-2 text-left hover:bg-transparent',
          project.missing && 'opacity-50',
        )}
      >
        <div className="flex flex-col gap-1 truncate">
          <span className="font-medium text-sm text-gray-700 dark:text-foreground">
            {project.name}
          </span>
          <span className="truncate w-full text-muted-foreground text-xs">{project.path}</span>
        </div>
        {project.missing ? (
          <Badge className="text-2xs rounded-sm" variant="warning">
            <Trans>Missing</Trans>
          </Badge>
        ) : branch !== null ? (
          <span
            className="flex max-w-[40%] items-center gap-1 text-muted-foreground text-xs"
            data-testid={`nav-recent-branch-${project.path}`}
          >
            <GitBranch aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">{branch}</span>
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

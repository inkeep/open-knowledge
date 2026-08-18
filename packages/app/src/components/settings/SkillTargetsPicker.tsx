// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import type { SkillFolderLinkPreview, SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { AgentBrandIcon, hostLabel } from '@/components/AgentIconCluster';
import { ChangedOutsideBadge } from '@/components/ChangedOutsideBadge';
import { SkillFolderLinkConfirmDialog } from '@/components/settings/SkillFolderLinkConfirmDialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useSkillTargets } from '@/hooks/use-skill-targets';
import { formatToolList } from '@/lib/tool-list-format';

/**
 * The per-scope FOLDERS surface: every host skills folder at this scope with its
 * observable state, and the two folder verbs — SYMLINK (pick another folder; it
 * merges into THIS one and becomes a symlink to it, so its agent reads
 * everything placed here; conflicts abort) and UNLINK (materialize back to
 * per-skill symlinks — lossless, the per-skill menus take over).
 *
 * Direction is "the row you act on survives". Acting on `.claude` and picking
 * `.cursor` leaves `.claude` a real folder and turns `.cursor` into a symlink to
 * it. It used to run the other way — the row you clicked became the symlink —
 * which read backwards against the arrow the row then drew, and left people
 * believing the folder they had just picked was the one that survived.
 */
export function SkillTargetsPicker({ scope }: { scope: SkillScope }) {
  const { i18n, t } = useLingui();
  const { state, saving, folderAction } = useSkillTargets();
  const [newRoot, setNewRoot] = useState('');
  const [pendingLink, setPendingLink] = useState<{
    root: string;
    target: string;
    pick: string;
    keep: string;
    preview: SkillFolderLinkPreview;
  } | null>(null);

  const folders =
    state.status === 'ready' ? (state.data.folders ?? []).filter((f) => f.scope === scope) : [];

  // Group by the folder that SURVIVES. A symlinked folder is not a peer of its
  // target — it is a reader of it — so it nests under the target rather than
  // taking a row of its own. Drawn flat, the arrow put the follower on the left
  // and the source on the right, which reads as "`.claude` owns these skills"
  // when the truth is the reverse.
  const byRoot = new Map(folders.map((f) => [f.root, f]));
  const isFollower = (f: (typeof folders)[number]): boolean =>
    (f.state === 'linked' || f.state === 'linked-parent') &&
    typeof f.target === 'string' &&
    byRoot.has(f.target);
  const followers = new Map<string, typeof folders>();
  for (const f of folders) {
    if (!isFollower(f)) continue;
    const target = f.target as string;
    followers.set(target, [...(followers.get(target) ?? []), f]);
  }
  // A follower whose target is NOT one of these rows (an out-of-scope or
  // vanished path) keeps its own row — otherwise it would disappear from the
  // list entirely and its unlink verb with it.
  const rows = folders.filter((f) => !isFollower(f));

  const runFolderAction = (root: string, action: 'link' | 'unlink', target?: string) => {
    void folderAction({ scope, root, action, ...(target !== undefined ? { target } : {}) }).catch(
      (err) => toast.error(err instanceof Error ? err.message : String(err)),
    );
  };

  const displayRoot = (root: string) => (scope === 'global' ? `~/${root}` : root);

  /**
   * A link only asks when it costs you something. Moves change what the
   * surviving folder's agent reads; destroyed entries and replaced deliveries
   * are outright losses. Duplicate drops are none of those — the folder becomes
   * a symlink to the folder holding the identical copies, so every agent reads
   * exactly what it read before — so they never open the dialog on their own.
   * The two refusals are reported here rather than fired at a request that can
   * only 409.
   */
  const runFolderLink = (root: string, target: string) => {
    const pick = displayRoot(root);
    const keep = displayRoot(target);
    void folderAction({ scope, root, action: 'link', target, preview: true })
      .then((p) => {
        if (!p) {
          toast.error(t`Could not classify the merge — try again.`);
          return;
        }
        if (p.conflicts.length > 0) {
          toast.error(
            t`${pick} and ${keep} both hold a different version of: ${p.conflicts.join(', ')}. Resolve those first — a symlink can only keep one of each.`,
          );
          return;
        }
        if (p.strays.length > 0) {
          toast.error(
            t`${pick} holds entries that aren't skills: ${p.strays.join(', ')}. Remove or move them from the folder and try again.`,
          );
          return;
        }
        if (p.moves.length + p.removes.length + p.replaces.length > 0) {
          setPendingLink({ root, target, pick, keep, preview: p });
          return;
        }
        return folderAction({ scope, root, action: 'link', target });
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  };

  const confirmPendingLink = () => {
    if (!pendingLink) return;
    const { root, target } = pendingLink;
    setPendingLink(null);
    void folderAction({ scope, root, action: 'link', target }).catch((err) =>
      toast.error(err instanceof Error ? err.message : String(err)),
    );
  };

  return (
    <section
      className="space-y-2 rounded-lg border bg-card p-3"
      data-testid="settings-skill-folders"
    >
      <div>
        <h4 className="text-sm font-medium">
          <Trans comment="Heading above the skill-folder list in Settings → Skills Studio — the reason, not the mechanism">
            Share skills between AI tools
          </Trans>
        </h4>
        <p className="text-1sm text-muted-foreground">
          <Trans comment="Says what symlinking two skill folders together buys the user, before any button names it">
            Each AI tool reads skills from its own folder. Point one folder at another and both
            tools see the same skills — add a skill once instead of copying it into every tool.
          </Trans>
        </p>
      </div>
      {state.status === 'error' ? (
        <div className="text-1sm text-destructive" role="alert" data-testid="skill-targets-error">
          <Trans>Failed to load skill settings: {state.message}</Trans>
        </div>
      ) : state.status !== 'ready' ? (
        <div className="space-y-2 pt-1">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-5 w-56" />
        </div>
      ) : (
        <ul className="space-y-1 pt-1">
          {rows.map((f) => {
            const display = displayRoot(f.root);
            const following = followers.get(f.root) ?? [];
            // Offerable: every OTHER root at this scope that can still BECOME a
            // symlink to this one. A folder that is already a symlink (its own,
            // or a parent's) has nothing left to merge and was the "why is that
            // still in the list" bug — picking it could only fail. Order is list
            // order: no name-based promotion of any root.
            //
            // `absent` stays offerable, and only because the server now filters
            // this list to roots whose agent home exists. So an absent row means
            // "`.claude` is here, `.claude/skills` is not yet" — linking it
            // creates a skills dir inside a dotdir the user already has, which is
            // squarely inside the consent boundary. Before that filter the same
            // disjunct offered `~/.copilot/skills` on a machine with no Copilot,
            // and accepting it created `~/.copilot` — after which OK's own
            // directory-based detection reported Copilot as installed.
            const targets = folders.filter(
              (o) => o.root !== f.root && (o.state === 'own' || o.state === 'absent'),
            );
            return (
              <li key={f.host} className="text-sm" data-testid={`skill-folder-row-${f.host}`}>
                <div className="flex items-center gap-2">
                  <AgentBrandIcon host={f.host} aria-hidden className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {display}
                    {/* Only reachable for a follower whose target left the list —
                      an ordinary follower nests under its target instead. */}
                    {f.state === 'linked' || f.state === 'linked-parent' ? (
                      <span className="text-muted-foreground"> → {f.target ?? '?'}</span>
                    ) : null}
                  </span>
                  {f.drift ? (
                    // PASSIVE disclosure, same doctrine as skill-level drift:
                    // something outside OK rewrote this folder since OK set it.
                    // No action here — the next explicit Symlink/Unlink wins.
                    <ChangedOutsideBadge
                      testId={`skill-folder-drift-${f.host}`}
                      title={t`OK last set this folder to ${f.expected ?? ''} — something outside OK changed it since. The state shown is what's on disk now; your next Symlink/Unlink wins.`}
                    />
                  ) : null}
                  {f.state === 'linked-parent' ? (
                    <span
                      className="shrink-0 text-[10px] text-muted-foreground uppercase tracking-wide"
                      title={t`A parent directory is the symlink — unlink that folder itself to take this one back.`}
                    >
                      <Trans>symlinked via parent</Trans>
                    </span>
                  ) : null}
                  {(f.state === 'own' || f.state === 'absent') && targets.length > 0 ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={saving}
                          className="h-5 shrink-0 rounded border border-border/60 px-1 font-normal text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                          title={t`Pick a folder to merge INTO ${display}. That folder becomes a symlink to this one, so its agent reads everything placed here. This folder stays real. Conflicting skills abort the merge.`}
                          data-testid={`skill-folder-link-${f.host}`}
                        >
                          <Trans>Link</Trans>
                        </Button>
                      </DropdownMenuTrigger>
                      {/* Size to the widest item, not the tiny trigger: the base
                        content width is the trigger width, which clipped the mono
                        editor-root paths (e.g. `~/.cursor/skills`). */}
                      <DropdownMenuContent align="end" className="w-auto">
                        {targets.map((o) => (
                          <DropdownMenuItem
                            key={o.root}
                            // THIS row survives: the PICKED folder is the one that
                            // merges in and becomes the symlink.
                            onSelect={() => runFolderLink(o.root, f.root)}
                            data-testid={`skill-folder-link-${f.host}-to-${o.root}`}
                          >
                            <AgentBrandIcon host={o.host} aria-hidden className="size-4" />
                            <span className="font-mono text-xs">
                              {scope === 'global' ? `~/${o.root}` : o.root}
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                  {f.state === 'linked' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={saving}
                      className="h-5 shrink-0 rounded border border-border/60 px-1 font-normal text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                      title={t`Turn ${display} back into a real directory holding a per-skill symlink for each skill it currently sees — nothing stops working, and each skill's menu manages it from there.`}
                      onClick={() => runFolderAction(f.root, 'unlink')}
                      data-testid={`skill-folder-unlink-${f.host}`}
                    >
                      <Trans>unlink</Trans>
                    </Button>
                  ) : null}
                </div>
                {/* The nesting alone never said what it meant. Naming the TOOLS
                    that end up sharing the folder does, in the words someone
                    picking a row already has — the paths below are the
                    mechanism, this is the outcome. */}
                {following.length > 0 ? (
                  <p
                    className="mt-1 ml-6 text-muted-foreground text-xs"
                    data-testid={`skill-folder-shared-${f.host}`}
                  >
                    {t`${formatToolList(
                      [f.host, ...following.map((o) => o.host)].map(hostLabel),
                      i18n.locale,
                    )} share this folder.`}
                  </p>
                ) : null}
                {/* Folders that read THIS one. They are readers, not peers, so
                    they sit under the folder that owns the skills — and each
                    keeps its own unlink, which is the verb that gives it back. */}
                {following.length > 0 ? (
                  <ul
                    className="mt-1 ml-2 space-y-1 border-border/60 border-l pl-3"
                    data-testid={`skill-folder-followers-${f.host}`}
                  >
                    {following.map((o) => (
                      <li key={o.host} className="flex items-center gap-2">
                        <AgentBrandIcon host={o.host} aria-hidden className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
                          {scope === 'global' ? `~/${o.root}` : o.root}
                        </span>
                        {o.drift ? (
                          <ChangedOutsideBadge
                            testId={`skill-folder-drift-${o.host}`}
                            title={t`OK last set this folder to ${o.expected ?? ''} — something outside OK changed it since. The state shown is what's on disk now; your next Symlink/Unlink wins.`}
                          />
                        ) : null}
                        {o.state === 'linked-parent' ? (
                          <span
                            className="shrink-0 text-[10px] text-muted-foreground uppercase tracking-wide"
                            title={t`A parent directory is the symlink — unlink that folder itself to take this one back.`}
                          >
                            <Trans>via parent</Trans>
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={saving}
                            className="h-5 shrink-0 rounded border border-border/60 px-1 font-normal text-[10px] text-muted-foreground uppercase tracking-wide hover:text-foreground"
                            title={t`Turn ${scope === 'global' ? `~/${o.root}` : o.root} back into a real directory holding a per-skill symlink for each skill it currently sees — nothing stops working, and each skill's menu manages it from there.`}
                            onClick={() => runFolderAction(o.root, 'unlink')}
                            data-testid={`skill-folder-unlink-${o.host}`}
                          >
                            <Trans>unlink</Trans>
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {/* Declare a NEW custom root — it becomes a row + link target from
          declaration (no first placement needed). No root is privileged. */}
      <form
        className="flex items-center gap-2 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = newRoot.trim().replace(/^~\//, '');
          if (trimmed === '') return;
          void folderAction({ scope, root: trimmed, action: 'add-root' })
            .then(() => setNewRoot(''))
            .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
        }}
        data-testid="skill-folders-add-root"
      >
        <Input
          value={newRoot}
          onChange={(e) => setNewRoot(e.target.value)}
          aria-label={t`Custom skills folder path`}
          placeholder={scope === 'global' ? t`~/.myteam/skills` : t`.myteam/skills`}
          className="h-7 flex-1 font-mono text-xs"
          disabled={saving}
          data-testid="skill-folders-add-root-input"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={saving || newRoot.trim() === ''}
          className="h-7 px-2 font-normal text-xs"
        >
          <Trans>Add custom path</Trans>
        </Button>
      </form>
      {pendingLink ? (
        <SkillFolderLinkConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setPendingLink(null);
          }}
          pick={pendingLink.pick}
          keep={pendingLink.keep}
          preview={pendingLink.preview}
          onConfirm={confirmPendingLink}
        />
      ) : null}
    </section>
  );
}

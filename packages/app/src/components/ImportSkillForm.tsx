import type { SkillDiscover, SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { FileArchive, Folder, GitBranch, Loader2Icon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { announceSkillImport } from '@/lib/skill-import-toast';
import { SKILL_SCOPE_ORDER, useSkillScopeLabels } from '@/lib/skill-scope';
import { discoverSkillsInSource, importSkill, uploadSkill } from '@/lib/skills-api';
import { cn } from '@/lib/utils';

/** Remote = fetch by reference (importSkill); Zip/Folder = send bytes (uploadSkill). */
type SkillSource = 'remote' | 'zip' | 'folder';

// Source picker choice card — mirrors SharingModeField's card styling so the two
// radio-card selectors read as one family. Checked state is applied per-card via
// a `source === value` ternary (below), not a `has-data-checked` selector.
const SOURCE_CARD_BASE =
  'flex items-start justify-between gap-3 rounded-md border p-3 text-sm font-normal transition-colors cursor-pointer';

/**
 * The unified "bring a skill you already have" form — the Import pane of the
 * skill modal. One Source selector switches between a remote reference (GitHub
 * `owner/repo`, a git URL, or a local path) and a local `.zip` / folder upload.
 * The modal supplies its own DialogHeader, so this renders body + footer only.
 */
export function ImportSkillForm({
  defaultScope,
  onOpenChange,
  onImported,
}: {
  defaultScope: SkillScope;
  onOpenChange: (open: boolean) => void;
  onImported: (imported: { scope: SkillScope; name: string }) => void;
}) {
  const { t } = useLingui();
  const sourceId = useId();
  const sourceGroupId = useId();
  const skillId = useId();
  const scopeId = useId();
  const fileId = useId();
  const scopeLabels = useSkillScopeLabels();

  const [scope, setScope] = useState<SkillScope>(defaultScope);
  const [source, setSource] = useState<SkillSource>('remote');
  const [reference, setReference] = useState('');
  const [skill, setSkill] = useState('');
  const [files, setFiles] = useState<FileList | null>(null);
  const [busy, setBusy] = useState(false);
  // Skills found in the remote source (null = not yet looked). The picker only
  // shows when a source bundles more than one, so a single-skill source imports
  // with no extra step.
  const [discovered, setDiscovered] = useState<SkillDiscover['skills'] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  // A finished probe that turned up nothing (bad ref / 404 / clone fail). Kept
  // distinct from `discovered === null` (not-yet-looked) so the hint shows only
  // after a real miss, not before the first probe.
  const [discoverMiss, setDiscoverMiss] = useState(false);

  // `webkitdirectory` is not typed on React inputs — toggle it on the DOM node
  // per source. The input is keyed by source so it remounts (clearing a stale
  // pick), and this effect re-applies the attribute on each remount.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (source === 'folder') {
      el.setAttribute('webkitdirectory', '');
      el.setAttribute('directory', '');
    } else {
      el.removeAttribute('webkitdirectory');
      el.removeAttribute('directory');
    }
  }, [source]);

  const trimmedReference = reference.trim();
  const isUpload = source === 'zip' || source === 'folder';
  // Folder picks report each file's webkitRelativePath; the first segment is the
  // chosen dir's name — the useful thing to echo back, not "500 files".
  const uploadFolderName = files?.[0]?.webkitRelativePath?.split('/')[0] ?? '';

  // Peek at the remote source (debounced) so we can offer a picker of what to
  // ingest instead of a blind "which skill" box. Discovery uses the same clone
  // as import, so if it fails, import would fail identically — no free-text
  // fallback needed. When several skills exist, preselect the first so Import
  // always resolves; otherwise clear `skill` and let the server pick the sole one.
  useEffect(() => {
    if (isUpload || trimmedReference === '') {
      setDiscovered(null);
      setDiscovering(false);
      setDiscoverMiss(false);
      setSkill('');
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setDiscovering(true);
    setDiscoverMiss(false);
    const timer = setTimeout(() => {
      void discoverSkillsInSource(trimmedReference, ctrl.signal).then((res) => {
        if (cancelled) return;
        setDiscovering(false);
        if (!res.ok) {
          setDiscovered(null);
          setSkill('');
          setDiscoverMiss(true);
          return;
        }
        setDiscoverMiss(false);
        setDiscovered(res.skills);
        setSkill(res.skills.length > 1 ? res.skills[0].name : '');
      });
    }, 500);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [trimmedReference, isUpload]);

  const canSubmit =
    !busy && (isUpload ? files !== null && files.length > 0 : trimmedReference !== '');

  async function runSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    if (isUpload && files !== null) {
      const fd = new FormData();
      if (source === 'zip') {
        fd.append('file', files[0]);
      } else {
        // Preserve the folder structure via each file's webkitRelativePath so
        // the server can reconstruct the skill dir.
        for (const f of Array.from(files)) {
          fd.append('files', f, f.webkitRelativePath || f.name);
        }
      }
      const result = await uploadSkill(fd, scope);
      setBusy(false);
      if (!result.ok) {
        toast.error(t`Upload failed: ${result.error}`);
        return;
      }
      announceSkillImport('upload', result);
      onImported({ scope, name: result.name });
      onOpenChange(false);
      return;
    }

    const result = await importSkill({
      source: trimmedReference,
      ...(skill.trim() !== '' ? { skill: skill.trim() } : {}),
      scope,
    });
    setBusy(false);
    if (!result.ok) {
      // Pre-import discovery runs a separate clone that can fail while import's
      // own clone succeeds — so the picker never rendered and this went in
      // blind. Import saw the bundle and returned the names: recover into the
      // picker instead of dead-ending on an un-actionable "pass skill" error.
      if (result.skills && result.skills.length > 1) {
        setDiscovered(result.skills.map((name) => ({ name, description: null })));
        setSkill(result.skills[0]);
        // Not a failure — the picker just needs a selection. `info`, not `error`,
        // so the recovery reads as a next step rather than a red alarm.
        toast.info(t`This source bundles several skills — choose one, then Import.`);
        return;
      }
      toast.error(t`Import failed: ${result.error}`);
      return;
    }
    announceSkillImport('import', result);
    onImported({ scope, name: result.name });
    onOpenChange(false);
  }

  return (
    <>
      <DialogBody className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor={scopeId}>
            <Trans>Scope</Trans>
          </Label>
          <Select value={scope} onValueChange={(v) => setScope(v as SkillScope)}>
            <SelectTrigger id={scopeId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SKILL_SCOPE_ORDER.map((s) => (
                <SelectItem key={s} value={s}>
                  {scopeLabels[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label id={sourceGroupId}>
            <Trans>Source</Trans>
          </Label>
          {/* Choice cards: stacked on narrow dialogs, horizontal (3-up) on wider
              screens. Each card carries a one-line description the bare toggle
              couldn't. */}
          <RadioGroup
            value={source}
            onValueChange={(v) => {
              setSource(v as SkillSource);
              setFiles(null);
            }}
            aria-labelledby={sourceGroupId}
            className="grid-cols-1 gap-2 sm:grid-cols-3 mb-2"
          >
            <Label
              htmlFor={`${sourceGroupId}-remote`}
              className={cn(
                SOURCE_CARD_BASE,
                source === 'remote'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted/40',
              )}
            >
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2 font-medium">
                  <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <Trans>Remote</Trans>
                </span>
                <span className="text-1sm text-muted-foreground">
                  <Trans>GitHub, a git URL, or a local path.</Trans>
                </span>
              </span>
              <RadioGroupItem id={`${sourceGroupId}-remote`} value="remote" className="mt-0.5" />
            </Label>
            <Label
              htmlFor={`${sourceGroupId}-zip`}
              className={cn(
                SOURCE_CARD_BASE,
                source === 'zip'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted/40',
              )}
            >
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2 font-medium">
                  <FileArchive
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Trans>Zip file</Trans>
                </span>
                <span className="text-1sm text-muted-foreground">
                  <Trans>A .zip or .skill archive.</Trans>
                </span>
              </span>
              <RadioGroupItem id={`${sourceGroupId}-zip`} value="zip" className="mt-0.5" />
            </Label>
            <Label
              htmlFor={`${sourceGroupId}-folder`}
              className={cn(
                SOURCE_CARD_BASE,
                source === 'folder'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted/40',
              )}
            >
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2 font-medium">
                  <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <Trans>Folder</Trans>
                </span>
                <span className="text-1sm text-muted-foreground">
                  <Trans>A folder containing SKILL.md.</Trans>
                </span>
              </span>
              <RadioGroupItem id={`${sourceGroupId}-folder`} value="folder" className="mt-0.5" />
            </Label>
          </RadioGroup>
          {isUpload ? (
            <>
              {/* Native file chrome ("Choose File / No file chosen") reads as an
                  unstyled wart next to the shadcn controls — keep the input for
                  its file/webkitdirectory behavior but drive it from a Button. */}
              <Input
                key={source}
                ref={inputRef}
                id={fileId}
                aria-label={source === 'zip' ? t`Choose a skill archive` : t`Choose a skill folder`}
                type="file"
                data-testid="skill-upload-input"
                accept={source === 'zip' ? '.zip,.skill' : undefined}
                onChange={(e) => setFiles(e.target.files)}
                className="sr-only"
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => inputRef.current?.click()}
                >
                  {source === 'zip' ? <Trans>Choose file</Trans> : <Trans>Choose folder</Trans>}
                </Button>
                <span
                  className="truncate text-sm text-muted-foreground"
                  data-testid="skill-upload-filename"
                >
                  {files && files.length > 0 ? (
                    source === 'folder' ? (
                      files.length === 1 ? (
                        t`${uploadFolderName} — 1 file`
                      ) : (
                        t`${uploadFolderName} — ${files.length} files`
                      )
                    ) : (
                      files[0].name
                    )
                  ) : (
                    <Trans>No file selected</Trans>
                  )}
                </span>
              </div>
            </>
          ) : (
            <>
              <Input
                id={sourceId}
                aria-label={t`Remote skill source`}
                data-testid="skill-import-source-input"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSubmit();
                }}
                placeholder={t`owner/repo, a git URL, or a local path`}
                className="font-mono"
              />
              {/* Live feedback only — the "what a Remote source is" description
                  lives in the radio card + placeholder, so idle shows nothing. */}
              {discovering || discoverMiss || (discovered && discovered.length === 1) ? (
                <p className="text-1sm text-muted-foreground">
                  {discovering ? (
                    <Trans>Checking source</Trans>
                  ) : discoverMiss ? (
                    <Trans>
                      No skill found at that source. Import will report why if you continue.
                    </Trans>
                  ) : discovered && discovered.length === 1 ? (
                    <Trans>Found one skill: {discovered[0].name}</Trans>
                  ) : null}
                </p>
              ) : null}
            </>
          )}
        </div>
        {!isUpload && discovered && discovered.length > 1 ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={skillId}>
              <Trans>Which skill</Trans>
            </Label>
            <Select value={skill} onValueChange={setSkill}>
              <SelectTrigger
                id={skillId}
                size="sm"
                className="w-full"
                data-testid="skill-import-pick"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {discovered.map((s) => (
                  <SelectItem key={s.name} value={s.name}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-1sm text-muted-foreground">
              <Trans>This source bundles several skills — choose the one to import.</Trans>
            </p>
          </div>
        ) : null}
        {/* Disclosure: a "what happens next" label over a plain bulleted list —
            no card, no per-item icons. */}
        <div role="note" className="space-y-3" data-testid="skill-import-disclosure">
          <p className="font-medium text-xs font-mono text-muted-foreground/80 uppercase tracking-wider">
            <Trans>What happens next</Trans>
          </p>
          <ul className="list-disc space-y-2.5 pl-4 text-sm text-muted-foreground marker:text-muted-foreground/50">
            <li>
              {scope === 'project' ? (
                <Trans>
                  Saved into this project's skills folder (e.g.{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground/80">
                    .agents/skills
                  </code>
                  ), versioned alongside your project.
                </Trans>
              ) : (
                <Trans>
                  Saved into your global skills folder (e.g.{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground/80">
                    ~/.agents/skills
                  </code>
                  ).
                </Trans>
              )}
            </li>
            <li>
              <Trans>Any scripts are shown for review, never run.</Trans>
            </li>
            <li>
              <Trans>
                Install it to your other editors (Claude Code, Cursor, Codex) to share it.
              </Trans>
            </li>
          </ul>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button
          variant="outline"
          className="font-mono uppercase"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onOpenChange(false)}
          disabled={busy}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button
          data-testid={isUpload ? 'skill-upload-button' : 'skill-import-button'}
          onClick={() => void runSubmit()}
          disabled={!canSubmit}
        >
          {busy ? (
            <>
              <Loader2Icon className="size-4 animate-spin" />
              {isUpload ? <Trans>Uploading</Trans> : <Trans>Importing</Trans>}
            </>
          ) : isUpload ? (
            <Trans>Upload</Trans>
          ) : (
            <Trans>Import</Trans>
          )}
        </Button>
      </DialogFooter>
    </>
  );
}

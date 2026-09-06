// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import type { SkillDiscover, SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { FileArchive, Folder, GitBranch } from 'lucide-react';
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
import { Spinner } from '@/components/ui/spinner';
import { announceSkillImport } from '@/lib/skill-import-toast';
import { SKILL_SCOPE_ORDER, useSkillScopeLabels } from '@/lib/skill-scope';
import { discoverSkillsInSource, importSkill, uploadSkill } from '@/lib/skills-api';
import { cn } from '@/lib/utils';

type SkillSource = 'remote' | 'zip' | 'folder';

const SOURCE_CARD_BASE =
  'flex items-start justify-between gap-3 rounded-md border p-3 text-sm font-normal transition-colors cursor-pointer';

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
  const [discovered, setDiscovered] = useState<SkillDiscover['skills'] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverMiss, setDiscoverMiss] = useState(false);

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
  const uploadFolderName = files?.[0]?.webkitRelativePath?.split('/')[0] ?? '';

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
      if (result.skills && result.skills.length > 1) {
        setDiscovered(result.skills.map((name) => ({ name, description: null })));
        setSkill(result.skills[0]);
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
          {}
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
              {}
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
              {}
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
        {}
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
              <Spinner aria-hidden="true" className="size-4" />
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

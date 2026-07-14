import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUp, Folder, Loader2, Plus, Server, TestTube2, Trash2 } from 'lucide-react';
import { type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';
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
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import type { OkDesktopBridge, OkSshMachine } from '@/lib/desktop-bridge-types';

type RemoteMachineValidationError = 'name-required' | 'host-required' | 'port-invalid';

type RemoteMachineValidationResult =
  | {
      ok: true;
      value: { name: string; host: string; port?: number };
    }
  | { ok: false; error: RemoteMachineValidationError };

type RemoteDirectoryListing = Awaited<ReturnType<OkDesktopBridge['remote']['listDirectories']>>;

type PendingAction = 'save' | 'test' | 'browse' | 'open' | 'remove' | null;
type ErrorField = 'machine-name' | 'machine-host' | 'machine-port' | 'remote-path' | null;

interface RemoteProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bridge: OkDesktopBridge;
}

/**
 * Normalize the credential-free SSH machine form before it crosses IPC.
 * Keeping this pure makes the port boundary (1..65535, integer only) explicit
 * and prevents whitespace-only aliases from becoming unusable saved entries.
 */
export function validateRemoteMachineDraft(input: {
  name: string;
  host: string;
  port: string;
}): RemoteMachineValidationResult {
  const name = input.name.trim();
  const host = input.host.trim();
  const portText = input.port.trim();

  if (name === '') return { ok: false, error: 'name-required' };
  if (host === '') return { ok: false, error: 'host-required' };

  if (portText === '') return { ok: true, value: { name, host } };

  if (!/^\d+$/.test(portText)) {
    return { ok: false, error: 'port-invalid' };
  }
  const port = Number(portText);
  if (port < 1 || port > 65_535) {
    return { ok: false, error: 'port-invalid' };
  }

  return { ok: true, value: { name, host, port } };
}

/** Display target for a saved machine without reproducing SSH config details. */
export function formatSshMachineTarget(machine: Pick<OkSshMachine, 'host' | 'port'>): string {
  return machine.port === undefined ? machine.host : `${machine.host}:${machine.port}`;
}

export function formatRemoteProjectError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message
    .replace(/^Error invoking remote method 'ok:remote:dispatch':\s*/, '')
    .replace(/^RemoteProjectError:\s*/, '')
    .trim();
  return message === '' ? fallback : message;
}

/**
 * Add an SSH machine and browse a project on it using the desktop bridge.
 * Authentication is deliberately delegated to the user's system SSH config
 * and agent; this surface never accepts or persists passwords/private keys.
 */
export function RemoteProjectDialog({ open, onOpenChange, bridge }: RemoteProjectDialogProps) {
  const { t } = useLingui();
  const machineSelectId = useId();
  const machineNameId = useId();
  const machineHostId = useId();
  const machinePortId = useId();
  const remotePathId = useId();
  const addMachineFormId = useId();
  const errorId = useId();

  const [machines, setMachines] = useState<OkSshMachine[] | null>(null);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [addingMachine, setAddingMachine] = useState(false);
  const [machineName, setMachineName] = useState('');
  const [machineHost, setMachineHost] = useState('');
  const [machinePort, setMachinePort] = useState('');
  const [pathInput, setPathInput] = useState('~');
  const [listing, setListing] = useState<RemoteDirectoryListing | null>(null);
  const [machinesLoading, setMachinesLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<ErrorField>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [machinePendingRemoval, setMachinePendingRemoval] = useState<OkSshMachine | null>(null);
  const browseRequestRef = useRef(0);
  const dialogGenerationRef = useRef(0);
  const remotePathInputRef = useRef<HTMLInputElement>(null);
  const focusPathAfterBrowseRef = useRef(false);

  const selectedMachine = machines?.find((machine) => machine.id === selectedMachineId) ?? null;
  const busy = machinesLoading || pendingAction !== null;
  const blocking =
    machinesLoading ||
    pendingAction === 'save' ||
    pendingAction === 'open' ||
    pendingAction === 'remove';

  const loadDirectory = async (machineId: string, path: string): Promise<void> => {
    if (path.trim() === '') {
      setError(t`Enter a remote path.`);
      setErrorField('remote-path');
      return;
    }
    // POSIX permits leading/trailing spaces in directory names. Use trim only
    // for the empty-value check; the path itself must cross IPC byte-for-byte.
    const requestedPath = path;

    const requestId = browseRequestRef.current + 1;
    browseRequestRef.current = requestId;
    setPendingAction('browse');
    setError(null);
    setErrorField(null);
    setStatus(null);
    setMachinePendingRemoval(null);
    setPathInput(requestedPath);

    try {
      const nextListing = await bridge.remote.listDirectories({ machineId, path: requestedPath });
      if (browseRequestRef.current === requestId) {
        setListing(nextListing);
        setPathInput(nextListing.path);
      }
    } catch (caught) {
      if (browseRequestRef.current === requestId) {
        const machineName =
          machines?.find((machine) => machine.id === machineId)?.name ?? t`the SSH machine`;
        const detail = formatRemoteProjectError(
          caught,
          t`Check that the path exists and that your SSH account can read it.`,
        );
        setError(t`Could not browse ${requestedPath} on ${machineName}. ${detail}`);
        setErrorField('remote-path');
      }
    }
    if (browseRequestRef.current === requestId) {
      focusPathAfterBrowseRef.current = true;
      setPendingAction(null);
    }
  };

  useEffect(() => {
    if (!open) return;

    const generation = dialogGenerationRef.current + 1;
    dialogGenerationRef.current = generation;
    let cancelled = false;
    browseRequestRef.current += 1;
    setMachines(null);
    setSelectedMachineId(null);
    setAddingMachine(false);
    setMachineName('');
    setMachineHost('');
    setMachinePort('');
    setPathInput('~');
    setListing(null);
    setMachinesLoading(true);
    setPendingAction(null);
    setError(null);
    setErrorField(null);
    setStatus(null);
    setMachinePendingRemoval(null);

    void bridge.remote
      .listMachines()
      .then((savedMachines) => {
        if (cancelled) return;
        setMachines(savedMachines);
        setSelectedMachineId(savedMachines[0]?.id ?? null);
        setAddingMachine(savedMachines.length === 0);
      })
      .catch((caught) => {
        if (cancelled) return;
        setMachines([]);
        setAddingMachine(true);
        setError(formatRemoteProjectError(caught, t`Failed to load SSH machines.`));
        setErrorField(null);
      })
      .finally(() => {
        if (!cancelled) setMachinesLoading(false);
      });

    return () => {
      cancelled = true;
      if (dialogGenerationRef.current === generation) dialogGenerationRef.current += 1;
      browseRequestRef.current += 1;
    };
  }, [open, bridge, t]);

  useEffect(() => {
    if (!open || addingMachine || selectedMachineId === null || machinesLoading) return;

    let cancelled = false;
    const requestId = browseRequestRef.current + 1;
    browseRequestRef.current = requestId;
    setPendingAction('browse');
    setError(null);
    setErrorField(null);
    setStatus(null);
    setPathInput('~');
    setListing(null);

    void bridge.remote
      .listDirectories({ machineId: selectedMachineId, path: '~' })
      .then((nextListing) => {
        if (cancelled || browseRequestRef.current !== requestId) return;
        setListing(nextListing);
        setPathInput(nextListing.path);
      })
      .catch((caught) => {
        if (cancelled || browseRequestRef.current !== requestId) return;
        const detail = formatRemoteProjectError(
          caught,
          t`Check that your SSH account can read its home directory.`,
        );
        setError(t`Could not browse the SSH home directory. ${detail}`);
        setErrorField('remote-path');
      })
      .finally(() => {
        if (!cancelled && browseRequestRef.current === requestId) setPendingAction(null);
      });

    return () => {
      cancelled = true;
      if (browseRequestRef.current === requestId) browseRequestRef.current += 1;
    };
  }, [open, addingMachine, selectedMachineId, machinesLoading, bridge, t]);

  useEffect(() => {
    if (pendingAction !== null || !focusPathAfterBrowseRef.current) return;
    focusPathAfterBrowseRef.current = false;
    remotePathInputRef.current?.focus();
  }, [pendingAction]);

  const resetMessages = (): void => {
    setError(null);
    setErrorField(null);
    setStatus(null);
  };

  const startAddingMachine = (): void => {
    resetMessages();
    setMachineName('');
    setMachineHost('');
    setMachinePort('');
    setAddingMachine(true);
  };

  const cancelAddingMachine = (): void => {
    resetMessages();
    setAddingMachine(false);
  };

  const submitMachine = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const validation = validateRemoteMachineDraft({
      name: machineName,
      host: machineHost,
      port: machinePort,
    });

    if (!validation.ok) {
      const message =
        validation.error === 'name-required'
          ? t`Enter a machine name.`
          : validation.error === 'host-required'
            ? t`Enter an SSH host or config alias.`
            : t`Enter a whole-number port from 1 to 65535.`;
      setError(message);
      setErrorField(
        validation.error === 'name-required'
          ? 'machine-name'
          : validation.error === 'host-required'
            ? 'machine-host'
            : 'machine-port',
      );
      setStatus(null);
      return;
    }

    setPendingAction('save');
    resetMessages();
    try {
      const savedMachine = await bridge.remote.saveMachine(validation.value);
      setMachines((current) => [
        ...(current ?? []).filter((machine) => machine.id !== savedMachine.id),
        savedMachine,
      ]);
      setSelectedMachineId(savedMachine.id);
      setAddingMachine(false);
      setStatus(t`Machine saved.`);
    } catch (caught) {
      setError(formatRemoteProjectError(caught, t`Failed to save the SSH machine.`));
    }
    setPendingAction(null);
  };

  const testConnection = async (): Promise<void> => {
    if (selectedMachine === null) return;
    const generation = dialogGenerationRef.current;
    setPendingAction('test');
    resetMessages();
    try {
      const result = await bridge.remote.testMachine(selectedMachine.id);
      if (dialogGenerationRef.current === generation) {
        if (result.ok) {
          setStatus(t`Connection successful.`);
        } else {
          setError(result.error.trim() === '' ? t`Connection failed.` : result.error);
        }
      }
    } catch (caught) {
      if (dialogGenerationRef.current === generation) {
        setError(formatRemoteProjectError(caught, t`Connection failed.`));
      }
    }
    if (dialogGenerationRef.current === generation) setPendingAction(null);
  };

  const requestMachineRemoval = (): void => {
    if (selectedMachine === null) return;
    resetMessages();
    setMachinePendingRemoval(selectedMachine);
  };

  const removeMachine = async (): Promise<void> => {
    if (machinePendingRemoval === null || machines === null) return;
    const target = machinePendingRemoval;
    setPendingAction('remove');
    resetMessages();
    try {
      await bridge.remote.removeMachine(target.id);
      const remaining = machines.filter((machine) => machine.id !== target.id);
      browseRequestRef.current += 1;
      setMachines(remaining);
      setListing(null);
      setSelectedMachineId(remaining[0]?.id ?? null);
      setAddingMachine(remaining.length === 0);
      setMachinePendingRemoval(null);
      setStatus(t`Machine removed.`);
    } catch (caught) {
      setError(formatRemoteProjectError(caught, t`Failed to remove the SSH machine.`));
    }
    setPendingAction(null);
  };

  const browseToInput = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (selectedMachine !== null) void loadDirectory(selectedMachine.id, pathInput);
  };

  const openProject = async (): Promise<void> => {
    if (selectedMachine === null) return;
    if (pathInput.trim() === '') {
      setError(t`Enter a remote path.`);
      setErrorField('remote-path');
      return;
    }

    setPendingAction('open');
    resetMessages();
    try {
      const opened = await bridge.remote.openProject({
        machineId: selectedMachine.id,
        path: pathInput,
      });
      if (opened) onOpenChange(false);
    } catch (caught) {
      setError(formatRemoteProjectError(caught, t`Failed to open the remote project.`));
    }
    setPendingAction(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && blocking) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={!blocking}
        onEscapeKeyDown={(event) => {
          if (blocking) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (blocking) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (blocking) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {machinePendingRemoval ? (
              <Trans>Remove SSH machine?</Trans>
            ) : (
              <Trans>Open remote project</Trans>
            )}
          </DialogTitle>
          <DialogDescription>
            {machinePendingRemoval ? (
              <Trans>Remove the saved connection for {machinePendingRemoval.name}?</Trans>
            ) : (
              <Trans>
                Connect to an SSH machine and open a project directly from its filesystem.
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {machinePendingRemoval ? (
            <div className="flex flex-col gap-3 text-sm">
              <p>
                <Trans>
                  This removes the machine and its saved recent-project and session metadata from
                  OpenKnowledge.
                </Trans>
              </p>
              <p className="text-muted-foreground">
                <Trans>
                  It never deletes or changes projects, files, or other data on the remote machine.
                </Trans>
              </p>
            </div>
          ) : machinesLoading ? (
            <div
              className="flex min-h-32 items-center justify-center gap-2 text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden />
              <Trans>Loading SSH machines...</Trans>
            </div>
          ) : addingMachine ? (
            <form id={addMachineFormId} className="flex flex-col gap-4" onSubmit={submitMachine}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-medium">
                    <Trans>Add SSH machine</Trans>
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <Trans>
                      OpenKnowledge uses your system SSH config and SSH agent. Passwords and private
                      keys are never stored.
                    </Trans>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <Trans>
                      The remote macOS or Linux machine needs Node.js 24 or newer and Git 2.31.0 or
                      newer in a POSIX-compatible login shell. OpenKnowledge installs its remote
                      support in your SSH home directory automatically.
                    </Trans>
                  </p>
                </div>
                {(machines?.length ?? 0) > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={cancelAddingMachine}
                    disabled={blocking || pendingAction === 'test'}
                  >
                    <Trans>Back</Trans>
                  </Button>
                ) : null}
              </div>

              <div className="grid gap-2">
                <Label htmlFor={machineNameId}>
                  <Trans>Machine name</Trans>
                </Label>
                <Input
                  id={machineNameId}
                  value={machineName}
                  onChange={(event) => setMachineName(event.target.value)}
                  placeholder={t`Development server`}
                  autoFocus
                  disabled={busy}
                  aria-invalid={errorField === 'machine-name'}
                  aria-describedby={errorField === 'machine-name' ? errorId : undefined}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor={machineHostId}>
                  <Trans>SSH host or config alias</Trans>
                </Label>
                <Input
                  id={machineHostId}
                  value={machineHost}
                  onChange={(event) => setMachineHost(event.target.value)}
                  placeholder={t`devbox or user@example.com`}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  aria-invalid={errorField === 'machine-host'}
                  aria-describedby={errorField === 'machine-host' ? errorId : undefined}
                />
              </div>

              <div className="grid gap-2 sm:max-w-32">
                <Label htmlFor={machinePortId}>
                  <Trans>Port (optional)</Trans>
                </Label>
                <Input
                  id={machinePortId}
                  value={machinePort}
                  onChange={(event) => setMachinePort(event.target.value)}
                  placeholder="22"
                  inputMode="numeric"
                  autoComplete="off"
                  disabled={busy}
                  aria-invalid={errorField === 'machine-port'}
                  aria-describedby={errorField === 'machine-port' ? errorId : undefined}
                />
              </div>
            </form>
          ) : selectedMachine !== null ? (
            <div className="flex flex-col gap-4">
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor={machineSelectId}>
                    <Trans>SSH machine</Trans>
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={startAddingMachine}
                    disabled={busy}
                  >
                    <Plus aria-hidden />
                    <Trans>Add machine</Trans>
                  </Button>
                </div>
                <div className="flex items-stretch gap-2">
                  <Select
                    value={selectedMachine.id}
                    onValueChange={(machineId) => {
                      resetMessages();
                      setSelectedMachineId(machineId);
                    }}
                    disabled={blocking || pendingAction === 'test'}
                  >
                    <SelectTrigger
                      id={machineSelectId}
                      className="h-auto min-w-0 flex-1 justify-start bg-muted/30 p-3"
                    >
                      <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate font-medium">{selectedMachine.name}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {formatSshMachineTarget(selectedMachine)}
                        </span>
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {machines?.map((machine) => (
                        <SelectItem key={machine.id} value={machine.id}>
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{machine.name}</span>
                            <span className="block truncate font-mono text-xs text-muted-foreground">
                              {formatSshMachineTarget(machine)}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void testConnection()}
                      disabled={busy}
                    >
                      {pendingAction === 'test' ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <TestTube2 aria-hidden />
                      )}
                      <Trans>Test connection</Trans>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t`Remove ${selectedMachine.name}`}
                      title={t`Remove machine`}
                      onClick={requestMachineRemoval}
                      disabled={busy}
                    >
                      {pendingAction === 'remove' ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <Trash2 aria-hidden />
                      )}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  <Trans>
                    Testing also installs or updates matching OpenKnowledge support in the SSH
                    user's home directory.
                  </Trans>
                </p>
              </div>

              <form className="grid gap-2" onSubmit={browseToInput}>
                <Label htmlFor={remotePathId}>
                  <Trans>Remote path</Trans>
                </Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      if (listing?.parentPath !== null && listing?.parentPath !== undefined) {
                        void loadDirectory(selectedMachine.id, listing.parentPath);
                      }
                    }}
                    disabled={busy || listing?.parentPath == null}
                  >
                    <ArrowUp aria-hidden />
                    <Trans>Up</Trans>
                  </Button>
                  <Input
                    ref={remotePathInputRef}
                    id={remotePathId}
                    className="font-mono"
                    value={pathInput}
                    onChange={(event) => setPathInput(event.target.value)}
                    spellCheck={false}
                    disabled={busy}
                    aria-invalid={errorField === 'remote-path'}
                    aria-describedby={errorField === 'remote-path' ? errorId : undefined}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={busy || pathInput.trim() === ''}
                  >
                    {pendingAction === 'browse' ? (
                      <Loader2 className="animate-spin" aria-hidden />
                    ) : null}
                    <Trans>Go</Trans>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  <Trans>
                    OpenKnowledge checks the folder first and asks before creating project files.
                  </Trans>
                </p>
              </form>

              <section
                className="min-h-36 max-h-60 overflow-y-auto rounded-lg border p-1 subtle-scrollbar"
                aria-label={t`Remote folders`}
                aria-busy={pendingAction === 'browse'}
              >
                {pendingAction === 'browse' && listing !== null ? (
                  <div
                    className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-xs"
                    role="status"
                  >
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    <Trans>Loading folders...</Trans>
                  </div>
                ) : null}
                {listing === null && pendingAction === 'browse' ? (
                  <div
                    className="flex min-h-32 items-center justify-center gap-2 text-muted-foreground"
                    role="status"
                  >
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    <Trans>Loading folders...</Trans>
                  </div>
                ) : listing === null ? (
                  <p className="p-3 text-sm text-muted-foreground">
                    <Trans>Enter a path to browse its folders.</Trans>
                  </p>
                ) : listing.directories.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">
                    <Trans>No folders in this location.</Trans>
                  </p>
                ) : (
                  <div className="grid gap-0.5">
                    {listing.directories.map((directory) => (
                      <Button
                        key={directory.path}
                        type="button"
                        variant="ghost"
                        className="h-auto w-full justify-start px-2 py-1.5 font-normal"
                        title={directory.path}
                        onClick={() => void loadDirectory(selectedMachine.id, directory.path)}
                        disabled={blocking || pendingAction === 'test'}
                      >
                        <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate">{directory.name}</span>
                      </Button>
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : null}

          {error !== null ? (
            <p id={errorId} className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {pendingAction === 'open' ? (
            <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
              <Trans>Opening remote project...</Trans>
            </p>
          ) : null}
          {status !== null ? (
            <p className="text-sm text-muted-foreground" role="status">
              {status}
            </p>
          ) : null}
        </DialogBody>

        <DialogFooter>
          {machinePendingRemoval ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  resetMessages();
                  setMachinePendingRemoval(null);
                }}
                disabled={busy}
              >
                <Trans>Keep machine</Trans>
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => void removeMachine()}
                disabled={busy}
              >
                {pendingAction === 'remove' ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : null}
                <Trans>Remove machine</Trans>
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={blocking}
            >
              <Trans>Cancel</Trans>
            </Button>
          )}
          {!machinePendingRemoval && addingMachine && !machinesLoading ? (
            <Button type="submit" form={addMachineFormId} disabled={busy}>
              {pendingAction === 'save' ? <Loader2 className="animate-spin" aria-hidden /> : null}
              <Trans>Save machine</Trans>
            </Button>
          ) : !machinePendingRemoval && selectedMachine !== null && !machinesLoading ? (
            <Button
              type="button"
              onClick={() => void openProject()}
              disabled={busy || pathInput.trim() === ''}
            >
              {pendingAction === 'open' ? <Loader2 className="animate-spin" aria-hidden /> : null}
              <Trans>Open project</Trans>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
